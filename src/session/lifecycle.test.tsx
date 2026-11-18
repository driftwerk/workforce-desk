import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announce, useDesk } from "../hub/store";
import type { HiddenSession, Session } from "../hub/types";
import { laidOut } from "../grids/engine";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { createGrid, deliver, layOut, setOpen, setPlacement, startGrids, useGrids } from "../grids/store";
import { Sessions } from "../settings/Sessions";
import { endSession, lifecycleActions, runs, sessionActions } from "./actions";
import { LifecycleDialogs } from "./LifecycleDialogs";
import { askLifecycle, CLOSED_LISTED, closeLifecycle, sweepRemoved, useLifecycle } from "./lifecycle";
import { useHubLayout } from "../groups/hubLayout";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

const session = (more: Partial<Session> = {}): Session => ({
  id: "s1",
  engine: "claude",
  name: "api-e7",
  goal: "",
  cwd: "/tmp",
  branch: null,
  origin: "desk",
  state: "stopped",
  live: false,
  cliSessionId: "c1",
  lastPrompt: null,
  lastReply: null,
  currentTool: null,
  pending: null,
  approvals: "desk",
  createdAt: "2026-10-29T08:00:00Z",
  updatedAt: "2026-10-29T08:00:00Z",
  ...more,
});

const hub = {
  end: vi.fn(() => Promise.resolve(session({ state: "closed" }))),
  remove: vi.fn(() => Promise.resolve({ removed: 1, transcripts: 0 })),
  clearFinished: vi.fn((c: { dryRun?: boolean }) => Promise.resolve({ removed: c.dryRun ? 3 : 3, transcripts: 0 })),
  resume: vi.fn(() => Promise.resolve(session({ live: true, state: "starting" }))),
  closedSessions: vi.fn(() => Promise.resolve([] as Session[])),
  hiddenSessions: vi.fn(() => Promise.resolve([] as HiddenSession[])),
  trackAgain: vi.fn(() => Promise.resolve()),
};

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

const shown = (s: Session) => {
  useDesk.setState({ sessions: { [s.id]: s }, hub: hub as never, openId: null });
  return s;
};

beforeEach(() => {
  Object.values(hub).forEach((f) => f.mockClear());
  hub.closedSessions.mockImplementation(() => Promise.resolve([]));
  closeLifecycle();
  useDesk.setState({ sessions: {}, hub: hub as never });
});
afterEach(cleanup);

describe("a session's life in its menus", () => {
  const labels = (s: Partial<Session>) => lifecycleActions(session(s)).map((a) => a.label);

  it("ends one Desk runs or that has stopped, and removes any; one in another terminal is only stopped being tracked", () => {
    expect(labels({ live: true, state: "working" })).toEqual(["End session…", "Remove…"]);
    expect(labels({ state: "stopped" })).toEqual(["End session…", "Remove…"]);
    expect(labels({ state: "closed" })).toEqual(["Remove…"]);
    expect(labels({ live: true, state: "idle", terminalId: "t1" })).toEqual(["Remove…"]);
    expect(labels({ origin: "external", state: "working" })).toEqual(["Stop tracking…"]);
    expect(labels({ origin: "external", state: "closed" })).toEqual(["Remove…"]);
  });

  it("never takes one Desk started for another terminal's when its process isn't held: it ends, removes and resumes", () => {
    // A machine's Claude Code that never drew, stopped: still "starting".
    const stuck = session({ machine: "devbox", live: false, state: "starting" });
    expect(lifecycleActions(stuck).map((a) => a.label)).toEqual(["End session…", "Remove…"]);
    expect(sessionActions(stuck).map((a) => a.label)).toEqual(["Resume"]);
    expect(runs(stuck)).toBe(false);
    expect(labels({ state: "working" })).toEqual(["End session…", "Remove…"]);
  });

  it("asks before ending one that works, and ends one that doesn't at once", async () => {
    render(<LifecycleDialogs />);
    endSession(shown(session({ state: "stopped" })));
    expect(hub.end).toHaveBeenCalledWith("s1");
    expect(screen.queryByRole("dialog")).toBeNull();

    hub.end.mockClear();
    act(() => endSession(shown(session({ live: true, state: "working" }))));
    const dialog = screen.getByRole("dialog", { name: "End “api-e7”?" });
    expect(hub.end).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe("Cancel");
    fireEvent.click(within(dialog).getByRole("button", { name: "End session" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(hub.end).toHaveBeenCalledWith("s1");
  });
});

describe("a machine's session", () => {
  it("is named in its End and Remove confirms by its own name, not this computer's with the same id", () => {
    useHubLayout.setState({ layout: { groups: [], ungrouped: { items: [], collapsed: false } } as never });
    const theirs = { ...session({ live: true, state: "working", displayName: "checkout on devbox" }), machine: "devbox" };
    useDesk.setState({ sessions: { s1: session({ live: true, state: "working", displayName: "api here" }), "devbox/s1": theirs } });
    render(<LifecycleDialogs />);
    act(() => askLifecycle({ kind: "end", sessionId: "devbox/s1" }));
    expect(screen.getByRole("dialog", { name: "End “checkout on devbox”?" })).toBeTruthy();
    act(() => closeLifecycle());
    act(() => askLifecycle({ kind: "remove", sessionId: "devbox/s1" }));
    expect(screen.getByRole("dialog").textContent).toContain("checkout on devbox");
    useHubLayout.setState({ layout: null });
  });
});

describe("removing a session", () => {
  const ask = (s: Session) => {
    shown(s);
    render(<LifecycleDialogs />);
    act(() => askLifecycle({ kind: "remove", sessionId: s.id }));
    return screen.getByRole("dialog");
  };

  it("keeps its engine's transcript unless ticked, with Cancel focused", async () => {
    const dialog = ask(session());
    expect(document.activeElement?.textContent).toBe("Cancel");
    const tick = within(dialog).getByRole("checkbox", { name: /Also delete its Claude Code transcript/ }) as HTMLInputElement;
    expect(tick.checked).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(hub.remove).toHaveBeenCalledWith("s1", false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useDesk.getState().sessions.s1).toBeUndefined();
  });

  it("deletes the transcript when ticked, saying it can't be resumed then", async () => {
    const dialog = ask(session());
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(within(dialog).getByText(/can't be resumed after this/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(hub.remove).toHaveBeenCalledWith("s1", true));
  });

  it("never deletes the transcript of one that runs", async () => {
    const dialog = ask(session({ live: true, state: "working" }));
    expect((within(dialog).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByText(/It's running, so it stops/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(hub.remove).toHaveBeenCalledWith("s1", false));
  });

  it("stops tracking one in another terminal, which keeps running there", () => {
    const dialog = ask(session({ origin: "external", state: "working" }));
    expect(within(dialog).getByRole("heading").textContent).toBe("Stop tracking “api-e7”?");
    expect(within(dialog).getByText(/keeps running in its own terminal/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Stop tracking" })).toBeTruthy();
  });

  it("closes the panes that showed it, leaving no empty pane where it was", async () => {
    freshGrids();
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    deliver(MAIN_GRID, { kind: "session", sessionId: "s2" });
    const dialog = ask(session());
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(hub.remove).toHaveBeenCalled());
    await waitFor(() => expect(laidOutIn(MAIN_GRID)).toEqual(["s2"]));
  });
});

const freshGrids = (role: { kind: "main" } | { kind: "grid"; gridId: string } = { kind: "main" }, store = memory()) => {
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null, filled: {} });
  startGrids(store, { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  if (role.kind === "grid") useGrids.setState({ role });
};

/** What each laid-out pane of grid `id` shows: a session's key, or null
 *  for an empty pane. */
const laidOutIn = (id: string) =>
  laidOut(useGrids.getState().grids[id]!.panes).map((p) =>
    p.content?.kind === "session" ? (p.content.machine ? `${p.content.machine}/${p.content.sessionId}` : p.content.sessionId) : (p.content?.kind ?? null),
  );

/** Every session any pane of grid `id` shows, parked ones too. */
const anywhereIn = (id: string) =>
  useGrids
    .getState()
    .grids[id]!.panes.flatMap((p) => (p.content?.kind === "session" ? [p.content.machine ? `${p.content.machine}/${p.content.sessionId}` : p.content.sessionId] : []))
    .sort();

describe("a session gone from the hub", () => {
  it("leaves the panes here however it went: cleared, or removed in another window or by its boss", () => {
    freshGrids();
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    deliver(MAIN_GRID, { kind: "session", sessionId: "s2" });
    expect(anywhereIn(MAIN_GRID)).toEqual(["s1", "s2"]);
    announce({ type: "removed", id: "s1" });
    expect(anywhereIn(MAIN_GRID)).toEqual(["s2"]);
    // Its neighbour takes its room: no empty pane is left behind.
    expect(laidOutIn(MAIN_GRID)).toEqual(["s2"]);
  });

  it("leaves a parked pane too, and every grid this window writes, a detached one whose window is closed included", () => {
    freshGrids();
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    deliver(MAIN_GRID, { kind: "session", sessionId: "s2" });
    layOut(MAIN_GRID, "one");
    const away = createGrid();
    deliver(away, { kind: "session", sessionId: "s1" });
    setPlacement(away, { kind: "window", mode: "fill", monitor: null });
    expect(anywhereIn(MAIN_GRID)).toEqual(["s1", "s2"]);
    announce({ type: "removed", id: "s1" });
    expect(anywhereIn(MAIN_GRID)).toEqual(["s2"]);
    // No parked pane is kept for it either.
    expect(useGrids.getState().grids[MAIN_GRID]!.panes.filter((p) => !p.rect)).toEqual([]);
    expect(anywhereIn(away)).toEqual([]);
  });

  it("leaves a grid whose own window is open to that window, which takes it out there", () => {
    freshGrids();
    const away = createGrid();
    deliver(away, { kind: "session", sessionId: "s1" });
    setPlacement(away, { kind: "window", mode: "fill", monitor: null });
    setOpen(away, true);
    announce({ type: "removed", id: "s1" });
    expect(anywhereIn(away)).toEqual(["s1"]);
    // In the grid's own window, the same event takes it out.
    useGrids.setState({ role: { kind: "grid", gridId: away } });
    announce({ type: "removed", id: "s1" });
    expect(anywhereIn(away)).toEqual([]);
  });

  it("takes out a machine's session by its machine's word, never this computer's with the same id", () => {
    freshGrids();
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1", machine: "devbox" });
    announce({ type: "removed", id: "s1", machine: "devbox" });
    expect(anywhereIn(MAIN_GRID)).toEqual(["s1"]);
  });
});

describe("a session removed while this window wasn't listening", () => {
  const loaded = (machine = "local") => ({ [machine]: { hub: hub as never, connected: true, loaded: true, error: null } });

  it("leaves the panes once its engine has said what it has: a closed one keeps its pane, to resume", async () => {
    freshGrids();
    layOut(MAIN_GRID, "thirds");
    for (const id of ["s1", "s2", "s3"]) deliver(MAIN_GRID, { kind: "session", sessionId: id });
    hub.closedSessions.mockImplementation(() => Promise.resolve([session({ id: "s3", state: "closed" })]));
    useDesk.setState({ sessions: { s2: session({ id: "s2" }) }, restore: [], engines: loaded() });
    await sweepRemoved("local");
    expect(anywhereIn(MAIN_GRID)).toEqual(["s2", "s3"]);
    expect(laidOutIn(MAIN_GRID)).not.toContain(null);
  });

  it("asks nothing and takes nothing before its engine has said, or when every pane's session is listed", async () => {
    freshGrids();
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    useDesk.setState({ sessions: {}, restore: [], engines: {} });
    await sweepRemoved("local");
    useDesk.setState({ sessions: { s1: session() }, engines: loaded() });
    await sweepRemoved("local");
    expect(hub.closedSessions).not.toHaveBeenCalled();
    expect(anywhereIn(MAIN_GRID)).toEqual(["s1"]);
  });

  it("takes nothing when its engine can't say what's closed", async () => {
    freshGrids();
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    hub.closedSessions.mockImplementation(() => Promise.reject(new Error("offline")));
    useDesk.setState({ sessions: {}, restore: [], engines: loaded() });
    await sweepRemoved("local");
    expect(anywhereIn(MAIN_GRID)).toEqual(["s1"]);
  });

  it("keeps a machine's session its engine offers to restore after a restart", async () => {
    freshGrids();
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1", machine: "devbox" });
    deliver(MAIN_GRID, { kind: "session", sessionId: "s2", machine: "devbox" });
    useDesk.setState({ sessions: {}, restore: [], engines: loaded("devbox") });
    announce({ type: "snapshot", machine: "devbox", sessions: [], restore: [session({ id: "s1" })], rooms: [] } as never);
    await waitFor(() => expect(anywhereIn(MAIN_GRID)).toEqual(["devbox/s1"]));
  });

  it("takes nothing on a full closed list, which may leave older closed sessions out", async () => {
    freshGrids();
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    const full = Array.from({ length: CLOSED_LISTED }, (_, i) => session({ id: `c${i}`, state: "closed" }));
    hub.closedSessions.mockImplementation(() => Promise.resolve(full));
    useDesk.setState({ sessions: {}, restore: [], engines: loaded() });
    await sweepRemoved("local");
    expect(anywhereIn(MAIN_GRID)).toEqual(["s1"]);
  });

  it("asks once for triggers together", async () => {
    freshGrids();
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    useDesk.setState({ sessions: {}, restore: [], engines: loaded() });
    await Promise.all([sweepRemoved("local"), sweepRemoved("local")]);
    expect(hub.closedSessions).toHaveBeenCalledTimes(1);
  });

  it("is swept when its engine's snapshot comes", async () => {
    freshGrids();
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    useDesk.setState({ sessions: {}, restore: [], engines: loaded() });
    announce({ type: "snapshot", sessions: [], restore: [], rooms: [] } as never);
    await waitFor(() => expect(anywhereIn(MAIN_GRID)).toEqual([]));
  });
});

describe("clearing finished sessions", () => {
  it("says how many finished more than 7 days ago, and clears them", async () => {
    render(<LifecycleDialogs />);
    act(() => askLifecycle({ kind: "clear" }));
    const dialog = screen.getByRole("dialog", { name: "Clear finished sessions?" });
    expect((within(dialog).getByRole("spinbutton") as HTMLInputElement).value).toBe("7");
    const go = await within(dialog).findByRole("button", { name: "Clear 3 sessions" });
    expect(hub.clearFinished).toHaveBeenCalledWith({ olderThanDays: 7, dryRun: true, transcripts: false });
    fireEvent.click(go);
    await waitFor(() => expect(hub.clearFinished).toHaveBeenCalledWith({ olderThanDays: 7, dryRun: false, transcripts: false }));
    await waitFor(() => expect(useLifecycle.getState().asking).toBeNull());
  });

  it("can't clear none", async () => {
    hub.clearFinished.mockImplementation(() => Promise.resolve({ removed: 0, transcripts: 0 }));
    render(<LifecycleDialogs />);
    act(() => askLifecycle({ kind: "clear" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "30" } });
    await within(dialog).findByText("None finished that long ago.");
    expect((within(dialog).getByRole("button", { name: "Clear 0 sessions" }) as HTMLButtonElement).disabled).toBe(true);
    expect(hub.clearFinished).toHaveBeenLastCalledWith({ olderThanDays: 30, dryRun: true, transcripts: false });
    hub.clearFinished.mockImplementation((c: { dryRun?: boolean }) => Promise.resolve({ removed: c.dryRun ? 3 : 3, transcripts: 0 }));
  });
});

describe("Settings → Sessions", () => {
  it("drops a closed session from its list as soon as it's removed elsewhere, by its boss too", async () => {
    hub.closedSessions.mockImplementation(() => Promise.resolve([session({ id: "x1", name: "vellev-07", state: "closed" }), session({ id: "x2", name: "acme-web", state: "closed" })]));
    useDesk.setState({ hub: hub as never });
    render(<Sessions />);
    await screen.findByText("vellev-07");
    act(() => announce({ type: "removed", id: "x1" }));
    expect(screen.queryByText("vellev-07")).toBeNull();
    expect(screen.getByText("acme-web")).toBeTruthy();
  });

  it("resumes a closed session from another terminal in Desk, and tracks a removed one again", async () => {
    hub.closedSessions.mockImplementation(() => Promise.resolve([session({ id: "x1", name: "vellev-07", origin: "external", state: "closed" })]));
    const removed: HiddenSession = { engine: "claude", cliSessionId: "c9", name: "monorepo-ae", cwd: "/tmp/m", hiddenAt: "2026-10-31T10:00:00Z" };
    hub.hiddenSessions.mockImplementation(() => Promise.resolve([removed]));
    useDesk.setState({ hub: hub as never });
    render(<Sessions />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume in Desk" }));
    await waitFor(() => expect(hub.resume).toHaveBeenCalledWith("x1"));
    fireEvent.click(screen.getByRole("button", { name: "Start tracking again" }));
    await waitFor(() => expect(hub.trackAgain).toHaveBeenCalledWith(removed));
  });
});
