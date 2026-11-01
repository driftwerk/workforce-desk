import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unread end to end: what a restart keeps, what shows while a hub is away,
// and the app's icon told of it.

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../restore/boot", () => ({
  deskState: {
    get: (k: string) => state.get(k),
    set: (k: string, v: unknown) => void state.set(k, v),
    remove: (k: string) => void state.delete(k),
    subscribe: () => () => {},
  },
}));
const invoked = vi.hoisted(() => [] as [string, unknown][]);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string, args: unknown) => void invoked.push([cmd, args])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", async (real) => ({ ...(await real<object>()), inApp: true }));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useRoomOrder } = await import("../rooms/order");
const { useSettings } = await import("../settings/store");
const { defaultShortcuts } = await import("../shortcuts/keys");
const { Sidebar } = await import("../shell/Sidebar");
const { useAppBadge } = await import("./icon");
const { startUnread, useUnread } = await import("./summary");
const { Unread } = await import("./Unread");

const ROOM = "6f1c2a4e-0b7d-4c55-9a51-3d2e8f9b1c07";
const at = (min: number) => new Date(Date.UTC(2026, 9, 30, 9, min)).toISOString();
const summary = {
  floor: at(0),
  rooms: [{ roomId: ROOM, main: { count: 3, forYou: 2, first: "m1", lastAt: at(9) }, threads: [] }],
  sessions: [],
  activity: { count: 0, lastAt: null },
  brief: null,
  update: null,
};

function Badge() {
  useAppBadge();
  return null;
}

beforeEach(() => {
  state.clear();
  invoked.length = 0;
  useSettings.setState({ shortcuts: {}, keys: defaultShortcuts(), groups: [], sessionNames: {} });
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "", local: true, revision: "" }], roster: [] });
  useRoomOrder.setState({ order: [ROOM] });
  useDesk.setState({
    connected: false,
    hub: null,
    view: "rooms",
    rooms: { [ROOM]: { id: ROOM, slug: "atlas-launch", name: "Atlas launch", members: [], defaultMember: null, createdAt: "", updatedAt: "" } },
    roomDrafts: {},
    inbox: false,
  });
  useUnread.setState({ local: null, localAt: null, dms: {}, dmsAt: {} });
});
afterEach(cleanup);

describe("unread, end to end", () => {
  it("shows what was counted before a restart while the hub is away, as of then, and badges the app", () => {
    // What the last run counted, kept as it is on every read.
    const counted = Date.UTC(2026, 9, 30, 9, 14);
    state.set("unread.cache.local", { at: counted, local: summary });
    const stop = startUnread();
    render(
      <>
        <Sidebar onAsk={() => {}} onNewSession={() => {}} onNewRoom={() => {}} onNewCrew={() => {}} onSettings={() => {}} />
        <Unread />
        <Badge />
      </>,
    );
    const row = screen.getAllByRole("button").find((b) => b.classList.contains("gi") && b.querySelector(".gi-name")?.textContent === "Atlas launch")!;
    expect(within(row).getByText("2 need you")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /^Unread/ })).getByText("2 need you")).toBeTruthy();
    expect(screen.getByText(/as of/)).toBeTruthy();
    expect(invoked).toContainEqual(["set_unread_badge", expect.objectContaining({ count: 2, dot: false })]);
    act(() => useUnread.setState({ local: { ...summary, rooms: [] } }));
    expect(invoked.at(-1)).toEqual(["set_unread_badge", expect.objectContaining({ count: 0, dot: false, overlay: null })]);
    stop();
  });

  it("hides the sidebar's Unread row and clears the app's badge when the page lists nothing, whatever else is new", () => {
    // Activity, a room this window doesn't know, and a session it doesn't
    // either: none of them is on the Unread page, so none lights anything.
    useUnread.setState({
      local: {
        ...summary,
        rooms: [{ roomId: "gone", main: { count: 2, forYou: 0, first: "m1", lastAt: at(9) }, threads: [] }],
        sessions: [{ id: "unknown", since: at(3), urgency: "new" }],
        activity: { count: 5, lastAt: at(8) },
      },
    });
    render(
      <>
        <Sidebar onAsk={() => {}} onNewSession={() => {}} onNewRoom={() => {}} onNewCrew={() => {}} onSettings={() => {}} />
        <Badge />
      </>,
    );
    expect(screen.queryByRole("button", { name: /^Unread/ })).toBeNull();
    expect(invoked.at(-1)).toEqual(["set_unread_badge", expect.objectContaining({ count: 0, dot: false, overlay: null })]);
    // Something listed only new: a dot, on the row and the icon.
    act(() => useUnread.setState((s) => ({ local: { ...s.local!, rooms: [{ roomId: ROOM, main: { count: 1, forYou: 0, first: "m1", lastAt: at(9) }, threads: [] }] } })));
    expect(within(screen.getByRole("button", { name: /^Unread/ })).getByText("unread")).toBeTruthy();
    expect(invoked.at(-1)).toEqual(["set_unread_badge", expect.objectContaining({ count: 0, dot: true })]);
    // Read, it all goes again.
    act(() => useUnread.setState((s) => ({ local: { ...s.local!, rooms: [] } })));
    expect(screen.queryByRole("button", { name: /^Unread/ })).toBeNull();
    expect(invoked.at(-1)).toEqual(["set_unread_badge", expect.objectContaining({ count: 0, dot: false })]);
  });

  it("keeps the sidebar's Unread row while the page is open", () => {
    useDesk.setState({ inbox: true });
    useUnread.setState({ local: { ...summary, rooms: [] } });
    render(<Sidebar onAsk={() => {}} onNewSession={() => {}} onNewRoom={() => {}} onNewCrew={() => {}} onSettings={() => {}} />);
    expect(screen.getByRole("button", { name: /^Unread/ }).getAttribute("aria-current")).toBe("true");
  });
});
