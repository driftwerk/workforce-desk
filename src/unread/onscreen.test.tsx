import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { Session, SessionUnread, TerminalInfo } from "../hub/types";
import type { PaneContent } from "../grids/engine";
import { GridCanvas } from "../grids/GridView";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { deliver, startGrids, useGrids } from "../grids/store";
import { useTerminals } from "../grids/terminals";
import { sessionItem } from "../groups/model";
import { SessionCard } from "../session/SessionCard";
import { itemBadge } from "./badges";
import { useBadgeData } from "./Marks";
import { markUnread, useReads } from "./reads";
import { SEEN_MS } from "./seen";
import { useUnread } from "./summary";
import { heardFocus, useDeskFocus } from "./focus";
import { useWatching } from "./watching";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("../session/Terminal", () => ({ Terminal: () => <div className="terminal-frame" /> }));

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

const T0 = "2026-10-31T09:00:00Z";
const T1 = "2026-10-31T09:01:00Z";
const T2 = "2026-10-31T09:02:00Z";
const T3 = "2026-10-31T09:03:00Z";

const session = (more: Partial<Session> = {}): Session => ({
  id: "s1",
  engine: "claude",
  name: "api-e7",
  goal: "",
  cwd: "/tmp",
  branch: null,
  origin: "desk",
  state: "done",
  live: true,
  cliSessionId: null,
  lastPrompt: null,
  lastReply: null,
  currentTool: null,
  pending: null,
  approvals: "desk",
  createdAt: T0,
  updatedAt: T1,
  ...more,
});

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

const summary = (sessions: SessionUnread[]) =>
  useUnread.setState({ local: { floor: T0, rooms: [], sessions, activity: { count: 0, lastAt: null }, brief: null, update: null } });
const finished = (since: string): SessionUnread => ({ id: "s1", since, urgency: "forYou" });

let puts: { place: string; point: { at: string; message: string | null }; mark: string }[] = [];
let focused = true;
let visibility: DocumentVisibilityState = "visible";

/** The session's sidebar badge, as this window draws it. */
let badge = { count: 0, dot: false };
function Probe() {
  badge = itemBadge(sessionItem("s1"), useBadgeData());
  return null;
}

const own: PaneContent = { kind: "session", sessionId: "s1" };
const term: PaneContent = { kind: "terminal", terminalId: "t1" };
const grid = () => (
  <>
    <GridCanvas grid={useGrids.getState().grids[MAIN_GRID]!} />
    <Probe />
  </>
);
/** The session's newest read point written. */
const lastPut = () => puts.filter((p) => p.place === "session:s1").at(-1)?.point.at;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-31T09:05:00Z"));
  FakeObserver.all = [];
  puts = [];
  focused = true;
  visibility = "visible";
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  useDeskFocus.setState({}, true);
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null, filled: {} });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "", local: true, revision: "" }], roster: [] });
  useDesk.setState({
    detached: false,
    view: "grids",
    openId: null,
    sessions: { s1: session() },
    hub: {
      putReads: vi.fn(async (p: typeof puts) => (puts.push(...p), p.map((x) => ({ place: x.place, ...x.point })))),
      closeTerminal: vi.fn(),
    } as never,
  });
  useTerminals.setState({ byId: {}, known: true, programs: {}, problems: {} });
  useReads.setState({ local: { "session:s1": { at: T0, message: null } }, dms: {}, loaded: true });
  useWatching.setState({ on: {}, held: {} });
  summary([finished(T1)]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a session on screen is read", () => {
  it("its pane in the grid shown: its badge goes at once, and clicking into it reads it at once", () => {
    deliver(MAIN_GRID, own);
    const { container } = render(grid());
    expect(badge.count).toBe(1);
    showAll();
    expect(badge.count).toBe(0);
    expect(puts).toEqual([]);
    fireEvent.pointerDown(container.querySelector(".terminal-frame")!);
    expect(puts).toEqual([{ place: "session:s1", point: { at: "2026-10-31T09:05:00.000Z", message: null }, mark: "advance" }]);
  });

  it("stays read while it works and finishes in sight: no badge, and its point follows each change", () => {
    deliver(MAIN_GRID, own);
    render(grid());
    showAll();
    wait(SEEN_MS);
    expect(lastPut()).toBe("2026-10-31T09:05:00.500Z");
    // Its hub's times are a moment before this window hears of them.
    vi.setSystemTime(new Date("2026-10-31T09:06:00.050Z"));
    act(() => useDesk.setState({ sessions: { s1: session({ state: "working", updatedAt: "2026-10-31T09:06:00.040123Z" }) } }));
    expect(badge.count).toBe(0);
    expect(lastPut()).toBe("2026-10-31T09:06:00.050Z");
    vi.setSystemTime(new Date("2026-10-31T09:07:00.050Z"));
    act(() => useDesk.setState({ sessions: { s1: session({ state: "done", updatedAt: "2026-10-31T09:07:00.040123Z" }) } }));
    act(() => summary([finished("2026-10-31T09:07:00.040123Z")]));
    expect(badge.count).toBe(0);
    expect(lastPut()).toBe("2026-10-31T09:07:00.050Z");
    // Coming back to it with nothing new writes nothing.
    const before = puts.length;
    focused = false;
    act(() => void window.dispatchEvent(new Event("blur")));
    focused = true;
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(badge.count).toBe(0);
    wait(SEEN_MS);
    expect(puts).toHaveLength(before);
  });

  it("not while Desk hasn't focus: one that finishes then is unread until Desk is in front again", () => {
    focused = false;
    deliver(MAIN_GRID, own);
    render(grid());
    showAll();
    wait(SEEN_MS * 2);
    expect(badge.count).toBe(1);
    expect(puts).toEqual([]);
    focused = true;
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(badge.count).toBe(0);
    wait(SEEN_MS);
    expect(lastPut()).toBeDefined();
  });

  it("out of sight, one that finishes is unread once, and read here or in another window it stops badging before its hub counts again", () => {
    render(<Probe />);
    expect(badge).toEqual({ count: 1, dot: false });
    act(() => useReads.setState({ local: { "session:s1": { at: T2, message: null } } }));
    expect(badge.count).toBe(0);
    act(() => summary([finished(T3)]));
    expect(badge.count).toBe(1);
  });

  it("a tracked session's terminal pane is that session on screen", () => {
    useDesk.setState({ sessions: { s1: session({ terminalId: "t1" }) } });
    const t1: TerminalInfo = { id: "t1", name: "zsh", cwd: "/tmp", envKeys: [], shell: "/bin/zsh", state: "running", live: true, exitCode: null, createdAt: T0, updatedAt: T0 };
    useTerminals.setState({ byId: { t1 } });
    deliver(MAIN_GRID, term);
    render(grid());
    showAll();
    expect(badge.count).toBe(0);
    wait(SEEN_MS);
    expect(lastPut()).toBe("2026-10-31T09:05:00.500Z");
  });

  it("its card open in the side panel", () => {
    render(
      <>
        <SessionCard session={useDesk.getState().sessions.s1!} />
        <Probe />
      </>,
    );
    showAll();
    expect(badge.count).toBe(0);
    wait(SEEN_MS);
    expect(lastPut()).toBe("2026-10-31T09:05:00.500Z");
  });

  it("not once it's gone out of sight, nor through what it does then", () => {
    deliver(MAIN_GRID, own);
    render(grid());
    showAll();
    wait(SEEN_MS);
    showAll(0);
    const before = puts.length;
    const later = "2026-10-31T09:10:00Z";
    vi.setSystemTime(new Date(later));
    act(() => useDesk.setState({ sessions: { s1: session({ state: "done", updatedAt: later }) } }));
    act(() => summary([finished(later)]));
    expect(puts).toHaveLength(before);
    expect(badge.count).toBe(1);
  });

  it("marked unread while it shows, it stays unread until it's shown again", async () => {
    deliver(MAIN_GRID, own);
    render(grid());
    showAll();
    wait(SEEN_MS);
    await act(() => markUnread({ kind: "session", session: "s1" }, { at: T0, message: null }));
    act(() => useReads.setState({ local: { "session:s1": { at: T0, message: null } } }));
    const before = puts.length;
    vi.setSystemTime(new Date("2026-10-31T09:08:00Z"));
    act(() => useDesk.setState({ sessions: { s1: session({ state: "done", updatedAt: T3 }) } }));
    act(() => summary([finished(T3)]));
    expect(badge.count).toBe(1);
    expect(puts).toHaveLength(before);
    showAll(0);
    showAll();
    wait(SEEN_MS);
    expect(badge.count).toBe(0);
    expect(lastPut()).toBe("2026-10-31T09:08:00.500Z");
  });

  it("in a detached grid's window: while it's visible and any Desk window has focus, not minimised nor once you've left Desk", () => {
    useDesk.setState({ detached: true });
    focused = false;
    deliver(MAIN_GRID, own);
    render(grid());
    // You work in the main window; the grid shows on another monitor.
    act(() => heardFocus("main", true));
    showAll();
    expect(badge.count).toBe(0);
    wait(SEEN_MS);
    expect(lastPut()).toBe("2026-10-31T09:05:00.500Z");

    // Minimised, what it does then isn't read.
    visibility = "hidden";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    const later = "2026-10-31T09:10:00Z";
    vi.setSystemTime(new Date(later));
    act(() => useDesk.setState({ sessions: { s1: session({ state: "done", updatedAt: later }) } }));
    act(() => summary([finished(later)]));
    wait(SEEN_MS * 2);
    expect(badge.count).toBe(1);
    expect(lastPut()).toBe("2026-10-31T09:05:00.500Z");

    // Visible again, but no Desk window has focus: still not.
    act(() => heardFocus("main", false));
    visibility = "visible";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    wait(SEEN_MS * 2);
    expect(badge.count).toBe(1);
    expect(lastPut()).toBe("2026-10-31T09:05:00.500Z");

    // Back in the main window: read, through now.
    act(() => heardFocus("main", true));
    expect(badge.count).toBe(0);
    wait(SEEN_MS);
    expect(lastPut()).toBe("2026-10-31T09:10:02.500Z");
  });

  it("not in the main window while only another Desk window has focus", () => {
    focused = false;
    deliver(MAIN_GRID, own);
    render(grid());
    act(() => heardFocus("grid-g2", true));
    showAll();
    wait(SEEN_MS * 2);
    expect(badge.count).toBe(1);
    expect(puts).toEqual([]);
  });
});
