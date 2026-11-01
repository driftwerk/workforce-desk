import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A DM with an agent on another hub (Allan, on a workspace's hub), while
// you talk to him: read while it's on screen, its replies there badge
// nothing and ask nothing of the Floor, and one that comes while you're
// elsewhere badges until you open it again.

const state = vi.hoisted(() => new Map<string, unknown>());
const subscribers = vi.hoisted(() => new Set<{ prefix: string; f: (key: string, value: unknown) => void }>());
vi.mock("../restore/boot", () => {
  const set = (k: string, v: unknown) => {
    state.set(k, structuredClone(v));
    for (const s of subscribers) if (k.startsWith(s.prefix)) s.f(k, v);
  };
  return {
    deskState: {
      get: (k: string) => state.get(k),
      set,
      setSoon: set,
      remove: (k: string) => void state.delete(k),
      subscribe: (prefix: string, f: (key: string, value: unknown) => void) => {
        const s = { prefix, f };
        subscribers.add(s);
        return () => subscribers.delete(s);
      },
      watch: () => () => {},
    },
  };
});
const surface = vi.hoisted(() => ({
  puts: [] as { agent: string; at: string; message: string | null; mark: string }[],
  refuse: null as number | null,
}));
vi.mock("../hubs/surface", async (real) => ({
  ...(await real<object>()),
  putConversationRead: vi.fn(async (_hub: unknown, agent: string, read: { at: string; message: string | null; mark: string }) => {
    if (surface.refuse) {
      const { HubError } = await import("../hub/client");
      throw new HubError(surface.refuse, "the hub can't keep read points");
    }
    surface.puts.push({ agent, ...read });
  }),
  activeConversations: vi.fn(async () => []),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));

const { useChat } = await import("../chat/store");
const { DESK_DM } = await import("../chat/types");
const { useDesk } = await import("../hub/store");
const { GridCanvas } = await import("../grids/GridView");
const { MAIN_GRID } = await import("../grids/model");
const { deliver, layOut, startGrids, useGrids } = await import("../grids/store");
const { agentItem } = await import("../groups/model");
const { useFloor, useMerged } = await import("../floor/store");
const { itemBadge } = await import("./badges");
const { useBadgeData } = await import("./Marks");
const { useReads, markUnread, restoreKeptDms, KEPT_DM_MS, LANDED_GRACE_MS } = await import("./reads");
const { SEEN_MS } = await import("./seen");
const { dmsFrom, useUnread } = await import("./summary");
const { noteSeen, useNeedsSeen } = await import("./needsSeen");
const { merged } = await import("../floor/merge");
/** What the watcher does as the needs and what's on screen change. */
const note = () => noteSeen(merged(useFloor.getState().hubs, useChat.getState().hubs).needs, () => true);
const { useWatching } = await import("./watching");
const { useDeskFocus } = await import("./focus");

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
class QuietSocket {
  static OPEN = 1;
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  close() {}
  send() {}
}

const showAll = (ratio = 1) => act(() => FakeObserver.all.forEach((o) => o.show(ratio)));
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

const HUB = { id: "dw", label: "Driftwerk", url: "https://dw.example.com", local: false, token: "t" };
const ALLAN = { hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false };
const KEY = "dw/allan";
const T1 = "2026-11-01T09:01:00Z";
const T2 = "2026-11-01T09:02:00Z";
const T3 = "2026-11-01T09:03:00Z";

const said = (id: string, at: string) => ({ id, role: "assistant" as const, content: `said at ${at}`, at, status: "complete" as const, tools: [] });

/** The hub's listing: what's unread in Allan's DM, and how far it's read. */
const listed = (count: number, last: { id: string; at: string } | null, read: { id: string; at: string } | null) =>
  dmsFrom(HUB, [
    {
      agent_id: "allan",
      channel: DESK_DM,
      updated_at: last?.at ?? T1,
      read: read && { at: read.at, message_id: read.id },
      unread: { count, for_you: count, first: null, last: last && { at: last.at, message_id: last.id }, capped: false },
    },
  ]);

/** A question Allan asked in his DM, as his hub's Floor lists it. */
const asked = (id: string, since: string) => ({
  id,
  kind: "question" as const,
  who: { kind: "agent" as const, id: "allan", name: "Allan", engine: null },
  ask: "Shall I ship it?",
  options: null,
  since,
  place: { kind: "dm" as const },
  answer: { kind: "reply" as const },
});
const floorWith = (needs: ReturnType<typeof asked>[]) =>
  useFloor.setState({
    hubs: {
      dw: {
        state: "ready",
        floor: { asOf: T3, needs, working: [], done: [], lanes: [], counts: { working: 0, needsYou: needs.length, doneToday: 0 }, more: { done: 0, lanes: 0 } },
        usage: null,
        offset: 0,
        stale: false,
        at: T3,
      },
    },
  });

let badge = { count: 0, dot: false };
let floorNeeds = 0;
function Probe() {
  badge = itemBadge(agentItem(ALLAN), useBadgeData());
  floorNeeds = useMerged().needs.length;
  return null;
}

const memory = () => {
  const kept = new Map<string, unknown>();
  return { get: (k: string) => kept.get(k), set: (k: string, v: unknown) => void kept.set(k, structuredClone(v)), remove: (k: string) => void kept.delete(k), subscribe: () => () => {} };
};

/** Allan's DM in a pane of the grid shown. */
const talking = () => {
  layOut(MAIN_GRID, "halves");
  deliver(MAIN_GRID, { kind: "agent", agent: KEY });
  render(
    <>
      <GridCanvas grid={useGrids.getState().grids[MAIN_GRID]!} />
      <Probe />
    </>,
  );
};

let focused = true;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-11-01T09:05:00Z"));
  state.clear();
  surface.puts = [];
  surface.refuse = null;
  focused = true;
  FakeObserver.all = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubGlobal("WebSocket", QuietSocket);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  Element.prototype.scrollIntoView = () => {};
  useDeskFocus.setState({}, true);
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null, filled: {} });
  startGrids(memory() as never, { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "", local: true, token: "" }, HUB],
    roster: [ALLAN],
    hubFeatures: { dw: new Set(["desk.reads"]) },
    histories: { [KEY]: { state: "ready", messages: [said("a1", T1)], more: false, earlier: "idle", loadedAt: T1 } },
  });
  useDesk.setState({ detached: false, view: "grids", openId: null, sessions: {} });
  useReads.setState({ local: {}, dms: { [KEY]: { at: T1, message: "a1" } }, loaded: true });
  useUnread.setState({ local: null, localAt: null, dms: {}, dmsAt: {} });
  useWatching.setState({ on: {}, held: {} });
  useFloor.setState({ hubs: {}, answered: {} });
  useNeedsSeen.setState({ seen: new Set() });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Allan's DM while you talk to him", () => {
  it("open in a focused Desk: a reply badges nothing, and it's read through it on his hub", async () => {
    talking();
    showAll();
    // He replies; his hub counts it before Desk's read point reaches it.
    act(() => listed(1, { id: "a2", at: T2 }, { id: "a1", at: T1 }));
    expect(badge).toEqual({ count: 0, dot: false });
    wait(SEEN_MS);
    await settle();
    expect(surface.puts.at(-1)).toMatchObject({ agent: "allan", at: T2, message: "a2", mark: "advance" });
  });

  it("stays read when a listing that left before the read landed says otherwise, here and after you leave", async () => {
    talking();
    showAll();
    act(() => listed(1, { id: "a2", at: T2 }, { id: "a1", at: T1 }));
    wait(SEEN_MS);
    await settle();
    // The listing the turn's end asked for, sent before the hub had the point.
    act(() => listed(1, { id: "a2", at: T2 }, { id: "a1", at: T1 }));
    expect(useReads.getState().dms[KEY]?.at).toBe(T2);
    showAll(0);
    expect(badge).toEqual({ count: 0, dot: false });
    // The hub catches up: it holds the point, which Desk no longer keeps.
    act(() => listed(0, { id: "a2", at: T2 }, { id: "a2", at: T2 }));
    expect(state.get("unread.dms.kept")).toEqual({});
  });

  it("stays read where its hub couldn't keep the point (503), across a restart", async () => {
    surface.refuse = 503;
    talking();
    showAll();
    act(() => listed(1, { id: "a2", at: T2 }, { id: "a1", at: T1 }));
    wait(SEEN_MS);
    await settle();
    expect(surface.puts).toEqual([]);
    showAll(0);
    act(() => listed(1, { id: "a2", at: T2 }, { id: "a1", at: T1 }));
    expect(badge).toEqual({ count: 0, dot: false });
    // Desk starts again: the point it kept is the DM's.
    act(() => useReads.setState({ dms: {} }));
    act(() => restoreKeptDms());
    act(() => listed(1, { id: "a2", at: T2 }, { id: "a1", at: T1 }));
    expect(badge).toEqual({ count: 0, dot: false });
  });

  it("lets go of a Mark unread its hub took once another Desk has moved on, but not before the write could land", async () => {
    talking();
    const place = { kind: "dm" as const, hub: "dw", agent: "allan" };
    act(() => listed(0, { id: "a2", at: T2 }, { id: "a2", at: T2 }));
    await act(() => markUnread(place, { at: T1, message: "a1" }));
    expect(surface.puts.at(-1)).toMatchObject({ at: T1, mark: "set" });
    // A listing sent before the hub took it still says T2.
    act(() => listed(1, { id: "a2", at: T2 }, { id: "a2", at: T2 }));
    expect(useReads.getState().dms[KEY]?.at).toBe(T1);
    // Later it says T3: read further on another Desk.
    wait(LANDED_GRACE_MS + 1);
    act(() => listed(0, { id: "a3", at: T3 }, { id: "a3", at: T3 }));
    expect(useReads.getState().dms[KEY]?.at).toBe(T3);
    expect(state.get("unread.dms.kept")).toEqual({});
  });

  it("ignores kept points that aren't whole or are long past", () => {
    const old = Date.now() - KEPT_DM_MS - 1;
    state.set("unread.dms.kept", {
      "dw/allan": { point: { at: "not a time", message: null }, mark: "advance", since: Date.now() },
      "dw/bob": { point: { at: T3, message: null }, mark: "set", since: old },
      "dw/cy": "garbage",
    });
    act(() => useReads.setState({ dms: {} }));
    act(() => restoreKeptDms());
    expect(useReads.getState().dms).toEqual({});
    act(() => listed(1, { id: "a2", at: T2 }, { id: "a1", at: T1 }));
    expect(useReads.getState().dms[KEY]?.at).toBe(T1);
  });

  it("while you're elsewhere a reply badges, and opening the DM clears it at once", () => {
    talking();
    act(() => listed(1, { id: "a2", at: T2 }, { id: "a1", at: T1 }));
    expect(badge).toEqual({ count: 1, dot: false });
    // Not while Desk isn't in front either.
    focused = false;
    showAll();
    expect(badge).toEqual({ count: 1, dot: false });
    focused = true;
    showAll();
    expect(badge).toEqual({ count: 0, dot: false });
  });

  it("a question he asks there asks nothing of the Floor or his badge; one asked elsewhere does until you open it", () => {
    talking();
    showAll();
    act(() => floorWith([asked("q1", T2)]));
    expect(floorNeeds).toBe(0);
    expect(badge.count).toBe(0);
    // Seen while it showed, it stays seen once you look away.
    act(() => note());
    showAll(0);
    expect(floorNeeds).toBe(0);
    expect(badge.count).toBe(0);
    // Asked while you're elsewhere: it needs you, until you open the DM.
    act(() => floorWith([asked("q1", T2), asked("q2", T3)]));
    expect(floorNeeds).toBe(1);
    expect(badge.count).toBe(1);
    showAll();
    expect(floorNeeds).toBe(0);
    expect(badge.count).toBe(0);
  });

  it("an approval asked in it still needs you", () => {
    talking();
    showAll();
    act(() =>
      floorWith([{ ...asked("p1", T2), kind: "approval" as never, answer: { kind: "decide", at: { kind: "routed", requestId: "r1" } } as never }]),
    );
    expect(floorNeeds).toBe(1);
  });

  it("clicking into it reads it at once", async () => {
    talking();
    act(() => listed(1, { id: "a2", at: T2 }, { id: "a1", at: T1 }));
    showAll();
    fireEvent.pointerDown(document.querySelector(".room-scroll")!);
    await settle();
    expect(surface.puts.at(-1)).toMatchObject({ at: T2, message: "a2" });
  });
});
