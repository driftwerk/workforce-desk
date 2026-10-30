import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../restore/boot", () => ({
  deskState: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => void state.set(k, v), remove: (k: string) => void state.delete(k) },
}));
vi.mock("../hubs/surface", async (real) => ({ ...(await real<object>()), putConversationRead: vi.fn(async () => {}), activeConversations: vi.fn(async () => []) }));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useOverview } = await import("../overview/store");
const { useUpdates } = await import("../updates/store");
const { useReads } = await import("./reads");
const { useUnread } = await import("./summary");
const { Unread } = await import("./Unread");

const at = (min: number) => new Date(Date.UTC(2026, 9, 30, 9, min)).toISOString();
const room = { id: "r1", slug: "atlas-launch", name: "Atlas launch", members: [], defaultMember: null, createdAt: "", updatedAt: "" };
let puts: unknown[] = [];
const markAllRead = vi.fn(async () => [
  { place: "room:r1", at: at(5), message: null },
  { place: "brief", at: at(1), message: null },
]);

beforeEach(() => {
  puts = [];
  state.clear();
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "", local: true, token: "" }], roster: [] });
  useDesk.setState({
    connected: true,
    rooms: { r1: room },
    sessions: {},
    timelines: {},
    roomDrafts: { r1: [{ id: "d1", member: "local/allan", threadId: null, asked: "q", since: Date.now(), text: "", working: null, tools: [], attachments: [], prompts: [], state: "live" }] },
    hub: {
      putReads: vi.fn(async (p: { place: string; point: object }[]) => (puts.push(...p), p.map((x) => ({ place: x.place, ...x.point })))),
      markAllRead,
    } as never,
  });
  useReads.setState({ local: { "room:r1": { at: at(2), message: "m2" } }, dms: {}, loaded: true });
  useOverview.setState({ overview: { brief: { text: "Morning summary", at: at(1), by: { id: "desk", name: "Desk" } }, counts: { working: 0, needsYou: 0, doneToday: 0 }, items: [] } });
  useUpdates.setState({ state: { phase: "ready", version: "1.4.0" } });
  useUnread.setState({
    dms: {},
    local: {
      floor: at(0),
      rooms: [{ roomId: "r1", main: { count: 2, forYou: 0, first: "m3", lastAt: at(5) }, threads: [] }],
      sessions: [],
      activity: { count: 0, lastAt: null },
      brief: at(1),
      update: null,
    },
  });
});
afterEach(cleanup);

const section = (name: string) => screen.getByRole("region", { name });

describe("the Unread page", () => {
  it("lists what needs you, then what's unread (for you first), then what's in flight", () => {
    render(<Unread />);
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Needs you", "Unread", "In flight"]);
    const unread = within(section("Unread"));
    expect(unread.getAllByText(/Desk report|Atlas launch|Desk 1\.4\.0 is ready/).map((e) => e.textContent)).toEqual([
      "Desk report",
      "Desk 1.4.0 is ready",
      "Atlas launch",
    ]);
    expect(within(section("In flight")).getByText("Atlas launch")).toBeTruthy();
    expect(within(section("Unread")).getByRole("button", { name: "Restart" })).toBeTruthy();
  });

  it("marks a row read, keeps it dimmed while you're here, and marks it unread from its menu", async () => {
    render(<Unread />);
    const row = within(section("Unread")).getByText("Atlas launch").closest(".urow")!;
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Mark read" }));
    await vi.waitFor(() => expect(puts).toEqual([{ place: "room:r1", point: { at: at(5), message: null }, mark: "advance" }]));
    act(() => useUnread.setState((s) => ({ local: { ...s.local!, rooms: [] } })));
    const dimmed = within(section("Unread")).getByText("Atlas launch").closest(".urow")!;
    expect(dimmed.className).toContain("urow-read");
    fireEvent.click(within(dimmed as HTMLElement).getByRole("button", { name: "More for Atlas launch" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark unread" }));
    await vi.waitFor(() => expect(puts.at(-1)).toMatchObject({ place: "room:r1", mark: "set" }));
  });

  it("marks everything read, and puts it back on Undo", async () => {
    render(<Unread />);
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Marked \d+ read/));
    expect(markAllRead).toHaveBeenCalledWith("everything");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await vi.waitFor(() =>
      expect(puts).toEqual([
        { place: "room:r1", point: { at: at(2), message: "m2" }, mark: "set" },
        { place: "brief", point: { at: at(0), message: null }, mark: "set" },
      ]),
    );
  });
});
