import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../restore/boot", () => ({
  deskState: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => void state.set(k, v), remove: (k: string) => void state.delete(k) },
}));
const dmReads = vi.hoisted(() => [] as unknown[]);
vi.mock("../hubs/surface", async (real) => ({
  ...(await real<object>()),
  putConversationRead: vi.fn(async (_hub: unknown, agent: string, read: unknown) => void dmReads.push({ agent, read })),
  activeConversations: vi.fn(async () => []),
}));
vi.mock("../chat/history", async (real) => ({
  ...(await real<object>()),
  readConversation: vi.fn(async (_hub: unknown, agent: string) => ({
    messages: agent === "allan" ? [{ id: "d3", from: "assistant", text: "Weekly **tickets** report attached.", at: "2026-10-30T09:07:00.000Z" }] : [],
    more: false,
  })),
}));
const opened = vi.hoisted(() => [] as unknown[]);
vi.mock("../shell/navigate", async (real) => ({ ...(await real<object>()), openTarget: (t: unknown, o: unknown) => void opened.push([t, o]) }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));

const { useChat } = await import("../chat/store");
const { useFloor } = await import("../floor/store");
const { approval, ready, view } = await import("../floor/testing");
const { useDesk } = await import("../hub/store");
const { useOverview } = await import("../overview/store");
const { useUpdates } = await import("../updates/store");
const { forgetPreviews } = await import("./previews");
const { useReads } = await import("./reads");
const { useUnread } = await import("./summary");
const { Unread } = await import("./Unread");

const at = (min: number) => new Date(Date.UTC(2026, 9, 30, 9, min)).toISOString();
const UUID = "6f1c2a4e-0b7d-4c55-9a51-3d2e8f9b1c07";
const room = { id: "r1", slug: "atlas-launch", name: "Atlas launch", members: [], defaultMember: null, createdAt: "", updatedAt: "" };
const draft = (id: string, s: "live" | "failed") => ({ id, member: "dw/allan", threadId: null, asked: "q", since: Date.now(), text: "", working: null, tools: [], attachments: [], prompts: [], state: s });
let puts: unknown[] = [];
const markAllRead = vi.fn(async () => [
  { place: "room:r1", at: at(5), message: null },
  { place: "brief", at: at(1), message: null },
]);
const summary = {
  floor: at(0),
  rooms: [{ roomId: "r1", main: { count: 2, forYou: 0, first: "m3", lastAt: at(5) }, threads: [] }],
  sessions: [],
  activity: { count: 0, lastAt: null },
  brief: at(1),
  update: null,
};

beforeEach(() => {
  puts = [];
  dmReads.length = 0;
  opened.length = 0;
  state.clear();
  forgetPreviews();
  useChat.setState({
    hubs: [
      { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "" },
      { id: "dw", label: "Atlas", url: "http://atlas.test", local: false, revision: "" },
    ],
    roster: [{ hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
    histories: {},
    hubFeatures: { dw: new Set(["desk.reads"]) },
  });
  useFloor.setState({ hubs: { local: ready(view({ needs: [approval("n1", "s1", { ask: "Run npm test?" })] })) }, deciding: {}, problems: {} });
  useDesk.setState({
    connected: true,
    rooms: { r1: room },
    sessions: { s1: { id: "s1", name: "acme-web", engine: "claude", state: "asking", live: true } as never },
    timelines: {},
    roomDrafts: { r1: [draft("d1", "live"), draft("d2", "failed")] },
    hub: {
      putReads: vi.fn(async (p: { place: string; point: object }[]) => (puts.push(...p), p.map((x) => ({ place: x.place, ...x.point })))),
      markAllRead,
    } as never,
  });
  useReads.setState({ local: { "room:r1": { at: at(2), message: "m2" } }, dms: {}, loaded: true });
  useOverview.setState({ overview: { brief: { text: "Morning summary", at: at(1), by: { id: "desk", name: "Desk" } }, counts: { working: 0, needsYou: 0, doneToday: 0 }, items: [] } });
  useUpdates.setState({ state: { phase: "ready", version: "1.4.0" } });
  useUnread.setState({
    localAt: null,
    dms: {
      "dw/allan": { count: 2, for_you: 2, first: "d2", last: { at: at(7), message_id: "d3" }, capped: false },
      [`dw/${UUID}`]: { count: 1, for_you: 0, first: "e1", last: { at: at(3), message_id: "e1" }, capped: false },
    },
    local: summary,
  });
});
afterEach(cleanup);

const section = (name: string) => screen.getByRole("region", { name });
const nothing = () =>
  act(() => {
    useFloor.setState({ hubs: {} });
    useDesk.setState({ roomDrafts: {} });
    useUpdates.setState({ state: { phase: "idle" } as never });
    useUnread.setState({ dms: {}, local: { ...summary, rooms: [], brief: null } });
  });

describe("the Unread page", () => {
  it("is cards: what needs you with the Floor's actions, what's unread for you first, and what's in flight", () => {
    render(<Unread />);
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Needs you", "Unread", "In flight"]);
    expect(screen.getByRole("heading", { level: 1, name: "Unread" })).toBeTruthy();
    expect(screen.getByText("2 need you · 5 unread")).toBeTruthy();
    const needs = within(section("Needs you"));
    expect(needs.getByText(/Run npm test\?/)).toBeTruthy();
    expect(needs.getByRole("button", { name: /^Allow/ })).toBeTruthy();
    expect(needs.getByRole("button", { name: /^Deny/ })).toBeTruthy();
    expect(needs.getByText("Allan’s answer failed")).toBeTruthy();
    expect(needs.getByRole("button", { name: "Retry Allan’s answer" })).toBeTruthy();
    const unread = within(section("Unread"));
    expect(unread.getAllByText(/^(Allan|Desk report|Atlas launch|Desk 1\.4\.0 is ready|An agent on Atlas)$/).map((e) => e.textContent)).toEqual([
      "Allan",
      "Desk report",
      "Desk 1.4.0 is ready",
      "Atlas launch",
      "An agent on Atlas",
    ]);
    expect(unread.getAllByText("DM · Atlas")).toHaveLength(2);
    expect(within(unread.getByRole("button", { name: /^Allan,/ }).closest(".urow") as HTMLElement).getByText("2 need you")).toBeTruthy();
    expect(unread.getByRole("button", { name: "Restart" })).toBeTruthy();
    expect(within(section("In flight")).getByText(/^Working/)).toBeTruthy();
  });

  it("shows the newest message of a DM, never ids", async () => {
    const { container } = render(<Unread />);
    expect(await screen.findByText("Weekly tickets report attached.")).toBeTruthy();
    expect(screen.getByText("1 new message from an agent")).toBeTruthy();
    for (const id of [UUID, "d3", "e1", "m3", "r1"]) expect(container.textContent).not.toMatch(new RegExp(`\\b${id}\\b`));
  });

  it("says you're all caught up when nothing is new and nothing needs you", () => {
    render(<Unread />);
    nothing();
    // What was read on this visit stays at hand, dimmed, under the empty state.
    expect(screen.getByText("You’re all caught up")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Unread" })).toBeNull();
    expect(within(section("Read just now")).getByText("Atlas launch")).toBeTruthy();
    expect(screen.getByText("Nothing new")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Mark all read" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(<Unread />);
    expect(screen.getByText("You’re all caught up")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Read just now" })).toBeNull();
  });

  it("opens a DM beside, and marks a row read, keeps it dimmed, and marks it unread", async () => {
    render(<Unread />);
    fireEvent.click(within(section("Unread")).getByRole("button", { name: /^Allan,/ }));
    expect(opened).toEqual([[{ kind: "agent", key: "dw/allan" }, { beside: true }]]);
    fireEvent.click(within(section("Unread")).getByRole("button", { name: "Mark Atlas launch read" }));
    await vi.waitFor(() => expect(puts).toEqual([{ place: "room:r1", point: { at: at(5), message: null }, mark: "advance" }]));
    act(() => useUnread.setState((s) => ({ local: { ...s.local!, rooms: [] } })));
    const dimmed = within(section("Unread")).getByText("Atlas launch").closest(".urow")!;
    expect(dimmed.className).toContain("urow-read");
    fireEvent.click(within(dimmed as HTMLElement).getByRole("button", { name: "Mark Atlas launch unread" }));
    await vi.waitFor(() => expect(puts.at(-1)).toMatchObject({ place: "room:r1", mark: "set" }));
  });

  it("marks everything read, and puts it back on Undo", async () => {
    render(<Unread />);
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await vi.waitFor(() => expect(screen.getByText(/^Marked \d+ read/)).toBeTruthy());
    expect(markAllRead).toHaveBeenCalledWith("everything");
    expect(dmReads).toContainEqual({ agent: "allan", read: { channel: "desk", at: at(7), message: "d3", mark: "advance" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await vi.waitFor(() =>
      expect(puts).toEqual(
        expect.arrayContaining([
          { place: "room:r1", point: { at: at(2), message: "m2" }, mark: "set" },
          { place: "brief", point: { at: at(0), message: null }, mark: "set" },
        ]),
      ),
    );
  });

  it("moves between rows with j and k, opens with Enter, and marks read with e", async () => {
    render(<Unread />);
    const key = (k: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k });
    key("j");
    expect(document.activeElement?.closest(".floor-need")).toBeTruthy();
    key("j");
    key("j");
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Allan,/);
    key("k");
    expect(document.activeElement?.closest(".floor-need")).toBeTruthy();
    key("End");
    expect(document.activeElement?.closest("[aria-label='In flight']")).toBeTruthy();
    key("Home");
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowDown");
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Desk report,/);
    key("e");
    await vi.waitFor(() => expect(puts).toContainEqual({ place: "brief", point: { at: at(1), message: null }, mark: "advance" }));
    // A field keeps its keys.
    const field = document.createElement("input");
    section("Unread").appendChild(field);
    field.focus();
    key("j");
    expect(document.activeElement).toBe(field);
  });
});
