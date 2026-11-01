import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { History } from "../chat/store";
import type { ChatMessage } from "../chat/types";
import type { RoomMessage, RoomSummary } from "../hub/types";

vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));
vi.mock("./engine", () => ({ say: vi.fn(async () => {}), answerForm: vi.fn(async () => {}), prune: () => {}, retry: () => {}, dismiss: () => {}, answerPrompt: () => true }));
const dmPuts = vi.hoisted(() => [] as { agent: string; at: string; message: string | null }[]);
vi.mock("../hubs/surface", async (real) => ({
  ...(await real<object>()),
  putConversationRead: vi.fn(async (_hub: unknown, agent: string, r: { at: string; message: string | null }) => void dmPuts.push({ agent, at: r.at, message: r.message })),
  activeConversations: vi.fn(async () => []),
}));

const { emptyConversation } = await import("../chat/conversation");
const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useUi } = await import("../shell/ui");
const { Timeline } = await import("./Timeline");
const { Rooms } = await import("./Rooms");
const { useReads } = await import("../unread/reads");
const { useUnread } = await import("../unread/summary");
const { useRoomMarker, useUnreadDms } = await import("../unread/Marks");
const { useWatching } = await import("../unread/watching");
const { SEEN_MS } = await import("../unread/seen");

// jsdom doesn't lay anything out.
Element.prototype.scrollIntoView = () => {};

/** An IntersectionObserver Desk drives: `showAll(ratio)` says how much of
 *  everything observed is on screen. */
class FakeObserver {
  static all: FakeObserver[] = [];
  observed: Element[] = [];
  constructor(private cb: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.observed = [];
  }
  show(ratio: number) {
    for (const el of this.observed)
      this.cb([{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
const showAll = (ratio = 1) => act(() => FakeObserver.all.forEach((o) => o.show(ratio)));
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

const room = {
  id: "r1",
  slug: "atlas-launch",
  name: "Atlas launch",
  channel: "desk:r1",
  members: [{ hub: "local", agent: "allan" }],
  defaultMember: "local/allan",
  createdAt: "",
  updatedAt: "",
};
const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 9, 0, s)).toISOString();
const msg = (id: string, s: number, over: Partial<RoomMessage> = {}): RoomMessage => ({
  id,
  roomId: "r1",
  threadId: null,
  author: "local/allan",
  content: `said ${id}`,
  hop: 0,
  createdAt: at(s),
  ...over,
});
const four = [msg("a", 1), msg("b", 2), msg("c", 3), msg("d", 4, { forYou: true })];
const readTo = (m: RoomMessage) => ({ at: m.createdAt, message: m.id });

let puts: { place: string; point: { at: string; message: string | null } }[] = [];
const summary = (rooms: RoomSummary[]) =>
  useUnread.setState({ local: { floor: at(0), rooms, sessions: [], activity: { count: 0, lastAt: null }, brief: null, update: null } });
const unread = (count: number, last: RoomMessage, first: RoomMessage) => ({ count, forYou: 0, first: first.id, lastAt: last.createdAt });

/** The room's sidebar marks, as this window draws them. */
let marker = { count: 0, dot: false };
function RoomProbe() {
  const m = useRoomMarker("r1");
  marker = { count: m.count, dot: m.dot };
  return null;
}
const placed = (place: string) => puts.filter((p) => p.place === place).map((p) => p.point);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  FakeObserver.all = [];
  puts = [];
  dmPuts.length = 0;
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.spyOn(document, "hasFocus").mockImplementation(() => true);
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }],
    roster: [{ hubId: "local", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
  });
  useUi.setState({ roomThreads: {}, anchors: {}, flash: null });
  useDesk.setState({
    rooms: { r1: room },
    timelines: { r1: four },
    windows: {},
    paging: {},
    roomDrafts: {},
    hub: { putReads: vi.fn(async (p: typeof puts) => (puts.push(...p), p.map((x) => ({ place: x.place, ...x.point })))) } as never,
  });
  useReads.setState({ local: { "room:r1": readTo(four[0]!) }, dms: {}, loaded: true });
  useWatching.setState({ on: {}, held: {} });
  summary([{ roomId: "r1", main: unread(3, four[3]!, four[1]!), threads: [] }]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const roomShown = () =>
  render(
    <>
      <Timeline room={room} thread={null} />
      <RoomProbe />
    </>,
  );

describe("a room on screen", () => {
  it("clears its badge as it opens and is read through its newest, its New line kept where you were", () => {
    const { container } = roomShown();
    expect(marker).toEqual({ count: 0, dot: true });
    showAll();
    expect(marker).toEqual({ count: 0, dot: false });
    wait(SEEN_MS);
    expect(placed("room:r1")).toEqual([readTo(four[3]!)]);
    expect(container.querySelector(".new-divider")?.nextElementSibling?.getAttribute("data-row")).toBe("b");
  });

  it("is read however far up it's scrolled, and its pill still offers what came since you opened it", () => {
    const { container } = roomShown();
    const pane = container.querySelector<HTMLElement>(".room-scroll")!;
    Object.defineProperty(pane, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(pane, "clientHeight", { configurable: true, value: 200 });
    const rows = [...container.querySelectorAll<HTMLElement>("[data-row]")];
    rows.forEach((r, i) => (r.getBoundingClientRect = () => ({ top: i === 0 ? 0 : 500, bottom: 0 }) as DOMRect));
    pane.getBoundingClientRect = () => ({ top: 0, bottom: 200 }) as DOMRect;
    pane.scrollTop = 0;
    fireEvent.scroll(pane);
    showAll();
    wait(SEEN_MS);
    expect(placed("room:r1")).toEqual([readTo(four[3]!)]);
    expect(useReads.getState().local["room:r1"]).toEqual(readTo(four[3]!));
    expect(screen.getByRole("button", { name: "3 new · Allan answered" })).toBeTruthy();
  });

  it("never badges for what arrives while it stays, and reads that too", () => {
    roomShown();
    showAll();
    wait(SEEN_MS);
    const e = msg("e", 5);
    act(() => useDesk.setState({ timelines: { r1: [...four, e] } }));
    act(() => summary([{ roomId: "r1", main: unread(1, e, e), threads: [] }]));
    expect(marker).toEqual({ count: 0, dot: false });
    expect(placed("room:r1").at(-1)).toEqual(readTo(e));
  });

  it("badges again for what arrives once you've gone elsewhere", () => {
    const { unmount } = render(<Timeline room={room} thread={null} />);
    const probe = render(<RoomProbe />);
    showAll();
    wait(SEEN_MS);
    unmount();
    const e = msg("e", 5);
    act(() => useDesk.setState({ timelines: { r1: [...four, e] } }));
    act(() => summary([{ roomId: "r1", main: unread(1, e, e), threads: [] }]));
    probe.rerender(<RoomProbe />);
    expect(marker.dot).toBe(true);
    expect(placed("room:r1")).toEqual([readTo(four[3]!)]);
  });

  it("a thread's pane open reads that thread, not the room's timeline", () => {
    const parent = four[0]!;
    const reply = msg("r", 6, { threadId: parent.id });
    useDesk.setState({ timelines: { r1: [...four, reply] } });
    summary([{ roomId: "r1", main: unread(3, four[3]!, four[1]!), threads: [{ parent, unread: unread(1, reply, reply) }] }]);
    render(
      <>
        <Timeline room={room} thread={parent.id} />
        <RoomProbe />
      </>,
    );
    showAll();
    wait(SEEN_MS);
    expect(placed(`thread:r1/${parent.id}`)).toEqual([readTo(reply)]);
    expect(placed("room:r1")).toEqual([]);
    expect(useUnread.getState().local!.rooms[0]!.threads).toHaveLength(1);
    // The room still has its own timeline's unread; the thread's is read.
    expect(marker).toEqual({ count: 0, dot: true });
    act(() => summary([{ roomId: "r1", main: unread(0, four[3]!, four[1]!), threads: [{ parent, unread: unread(1, reply, reply) }] }]));
    expect(marker).toEqual({ count: 0, dot: false });
  });
});

describe("a DM on screen", () => {
  const said = (id: string, s: number): ChatMessage => ({ id, role: "assistant", content: `said ${id}`, at: at(s), status: "complete", tools: [] });
  const history = (messages: ChatMessage[]): History => ({ state: "ready", messages, more: false, earlier: "idle", loadedAt: at(0) });
  let dms: ReturnType<typeof useUnreadDms> = {};
  function DmProbe() {
    dms = useUnreadDms();
    return null;
  }

  it("stays read while the agent streams and answers", () => {
    useDesk.setState({ activeRoom: null });
    useChat.setState({
      hubs: [{ id: "dw", label: "Driftwerk", url: "https://dw", local: false, revision: "t" }],
      roster: [{ hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
      activeAgent: "dw/allan",
      conversations: { "dw/allan": { ...emptyConversation(), connected: true } },
      histories: { "dw/allan": history([said("h1", 1)]) },
    });
    useUnread.setState({ dms: { "dw/allan": { count: 1, for_you: 1, first: "h1", last: { at: at(1), message_id: "h1" }, capped: false } } });
    render(
      <>
        <Rooms />
        <DmProbe />
      </>,
    );
    expect(Object.keys(dms)).toEqual(["dw/allan"]);
    showAll();
    expect(dms).toEqual({});
    wait(SEEN_MS);
    expect(dmPuts).toEqual([{ agent: "allan", at: at(1), message: "h1" }]);
    // It answers again: streamed, then kept by its hub and counted unread.
    act(() => useChat.setState({ conversations: { "dw/allan": { ...emptyConversation(), connected: true, messages: [said("live", 7)] } } }));
    act(() => useChat.setState({ histories: { "dw/allan": history([said("h1", 1), said("h2", 8)]) } }));
    act(() => useUnread.setState({ dms: { "dw/allan": { count: 1, for_you: 1, first: "h2", last: { at: at(8), message_id: "h2" }, capped: false } } }));
    expect(dms).toEqual({});
    expect(dmPuts.at(-1)).toEqual({ agent: "allan", at: at(8), message: "h2" });
  });
});
