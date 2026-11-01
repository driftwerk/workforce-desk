import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { HiddenSession, Session } from "../hub/types";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { deliver, layOut, startGrids, useGrids } from "../grids/store";
import { Sessions } from "../settings/Sessions";
import { endSession, lifecycleActions } from "./actions";
import { LifecycleDialogs } from "./LifecycleDialogs";
import { askLifecycle, closeLifecycle, useLifecycle } from "./lifecycle";

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

  it("empties the panes that showed it", async () => {
    useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
    startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    const dialog = ask(session());
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(hub.remove).toHaveBeenCalled());
    await waitFor(() => expect(useGrids.getState().grids[MAIN_GRID]!.panes.some((p) => p.content?.kind === "session")).toBe(false));
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
