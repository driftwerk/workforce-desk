import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../testing/sockets";

// Rooms end to end: the real engine, stores and views, over a fake local
// hub and fake agent conversations.

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../restore/boot", () => ({
  deskState: {
    get: (k: string) => state.get(k),
    set: (k: string, v: unknown) => void state.set(k, v),
    remove: (k: string) => void state.delete(k),
    watch: () => () => {},
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useRoomOrder } = await import("./order");
const { useSettings } = await import("../settings/store");
const { defaultShortcuts } = await import("../shortcuts/keys");
const { useAppShortcut } = await import("../shortcuts/manager");
const { Sidebar } = await import("../shell/Sidebar");
const { useUi } = await import("../shell/ui");
const { useReads } = await import("../unread/reads");
const { useUnread } = await import("../unread/summary");
const { RoomView } = await import("./RoomView");
const { prune, stop, stopTarget } = await import("./engine");

const ROOM = "6f1c2a4e-0b7d-4c55-9a51-3d2e8f9b1c07";
const OTHER = "11111111-2222-4333-8444-555555555555";
const CHANNEL = `desk:${ROOM}`;
const room = {
  id: ROOM,
  slug: "atlas-launch",
  name: "Atlas launch",
  channel: CHANNEL,
  members: [{ hub: "dw", agent: "allan" }],
  defaultMember: "dw/allan",
  createdAt: "",
  updatedAt: "",
};
const other = { ...room, id: OTHER, slug: "acme-web", name: "acme-web", channel: `desk:${OTHER}` };
const at = (min: number) => new Date(Date.UTC(2026, 9, 30, 9, min)).toISOString();
const msg = (id: string, min: number, over: Record<string, unknown> = {}) => ({
  id,
  roomId: ROOM,
  threadId: null,
  author: "dw/allan",
  content: `said ${id}`,
  hop: 0,
  createdAt: at(min),
  ...over,
});

const posts: Record<string, unknown>[] = [];
const unread = (count: number, forYou: number) => ({ count, forYou, first: null, lastAt: at(9) });

/** Opens a member's conversation as a hub that streams turns. */
const connect = async (agent: string) => {
  await vi.waitFor(() => expect(FakeSocket.find("/ws", agent, CHANNEL)).toBeDefined());
  const s = FakeSocket.find("/ws", agent, CHANNEL)!;
  await new Promise((r) => setTimeout(r, 0));
  s.receive({ type: "connected", session_id: `s-${agent}`, features: ["desk.place", "desk.stream"] });
  return s;
};

/** Stop an answer (⌘.) as the app does: the open thread's first. */
function Shortcuts() {
  useAppShortcut(
    "stopAnswer",
    () => {
      const d = useDesk.getState();
      const draft = stopTarget(d.roomDrafts[ROOM] ?? [], null);
      if (draft) stop(ROOM, draft.id);
    },
    true,
    { fromFields: false },
  );
  return null;
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ messages: [], more: false }), { headers: { "content-type": "application/json" } })),
  );
  FakeSocket.reset();
  state.clear();
  posts.length = 0;
  prune({});
  useSettings.setState({ shortcuts: {}, keys: defaultShortcuts(), groups: [], sessionNames: {} });
  useChat.setState({
    hubs: [{ id: "dw", label: "Acme", url: "https://acme.example.com", local: false, revision: "t" }],
    roster: [{ hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
    me: { local: { id: "p", name: "You", picture: null } },
  });
  useUi.setState({ roomThreads: {}, anchors: {}, flash: null });
  useRoomOrder.setState({ order: [ROOM, OTHER] });
  let n = 0;
  useDesk.setState({
    view: "rooms",
    activeRoom: ROOM,
    rooms: { [ROOM]: room, [OTHER]: other },
    timelines: { [ROOM]: [msg("m1", 1, { author: "you" }), msg("m2", 2), msg("m3", 3, { forYou: true })] },
    windows: {},
    roomDrafts: {},
    hub: {
      post: async (roomId: string, m: Record<string, unknown>) => {
        posts.push(m);
        return { message: { id: `p${++n}`, roomId, threadId: m.threadId ?? null, hop: 0, createdAt: at(10 + n), ...m }, created: true };
      },
      roomMessages: async () => [],
    } as never,
  });
  useReads.setState({ local: { [`room:${ROOM}`]: { at: at(2), message: "m2" } }, dms: {}, loaded: true });
  useUnread.setState({
    dms: {},
    local: {
      floor: at(0),
      rooms: [
        { roomId: ROOM, main: unread(1, 1), threads: [] },
        { roomId: OTHER, main: unread(2, 0), threads: [] },
      ],
      sessions: [],
      activity: { count: 0, lastAt: null },
      brief: null,
      update: null,
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sidebar = () => <Sidebar onAsk={() => {}} onNewSession={() => {}} onNewRoom={() => {}} onNewCrew={() => {}} onSettings={() => {}} />;
const rowOf = (name: string) =>
  screen.getAllByRole("button").find((b) => b.classList.contains("gi") && b.querySelector(".gi-name")?.textContent === name)!;
const drafts = () => useDesk.getState().roomDrafts[ROOM] ?? [];

describe("rooms, end to end", () => {
  it("opens at the read point, badges what's for you and dots what's new, and stops an answer with ⌘.", async () => {
    const { container } = render(
      <>
        {sidebar()}
        <RoomView room={room} />
        <Shortcuts />
      </>,
    );
    // The New line is where the room was read to, and the rows say what's waiting.
    expect(container.querySelector(".new-divider")?.nextElementSibling?.getAttribute("data-row")).toBe("m3");
    expect(within(rowOf("Atlas launch")).getByText("1 needs you")).toBeTruthy();
    expect(rowOf("acme-web").querySelector(".side-dot")).not.toBeNull();

    // Ask Allan in two threads: the second waits for the first.
    const { say } = await import("./engine");
    await act(() => say(room, "@allan one", "t1"));
    await act(() => say(room, "@allan two", "t2"));
    const allan = await connect("allan");
    await vi.waitFor(() => expect(allan.chats).toHaveLength(1));
    const ref = allan.chats[0]!.turn_ref as string;
    act(() => {
      allan.receive({ type: "stream_start", turn_ref: ref, id: "a1" });
      allan.receive({ type: "stream_delta", turn_ref: ref, id: "a1", content: "Checking" });
    });
    expect(rowOf("Atlas launch").querySelector(".mark")).not.toBeNull();

    // ⌘. stops it: kept as stopped, and the other thread's ask goes.
    act(() => void fireEvent.keyDown(window, { code: "Period", metaKey: true }));
    expect(drafts().map((d) => [d.threadId, d.state])).toEqual([
      ["t1", "stopped"],
      ["t2", "live"],
    ]);
    await vi.waitFor(() => expect(allan.chats).toHaveLength(2));

    // Its answer arrives anyway: the stopped draft goes.
    const asked = (allan.chats[0]!.desk as { message: string }).message;
    act(() => useDesk.getState().keep(msg("late", 20, { threadId: "t1", inReplyTo: asked }) as never));
    expect(drafts().map((d) => d.threadId)).toEqual(["t2"]);
  });
});
