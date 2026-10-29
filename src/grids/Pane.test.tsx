import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import type { PaneContent } from "./engine";
import { GridCanvas, LayoutUndo } from "./GridView";
import { MAIN_GRID } from "./model";
import type { GridStorage } from "./storage";
import { dropPane } from "./drag";
import { createGrid, deliver, layOut, startGrids, useGrids } from "./store";
import { useTerminals } from "./terminals";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

const session = (id: string, name: string, more: Partial<Session> = {}): Session => ({
  id,
  engine: "claude",
  name,
  goal: "",
  cwd: "/tmp",
  branch: null,
  origin: "desk",
  state: "idle",
  live: false,
  cliSessionId: null,
  lastPrompt: null,
  lastReply: null,
  currentTool: null,
  pending: null,
  approvals: "desk",
  createdAt: "2026-10-29T08:00:00Z",
  updatedAt: "2026-10-29T08:00:00Z",
  ...more,
});

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, v), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

const sess = (id: string): PaneContent => ({ kind: "session", sessionId: id });
const closeTerminal = vi.fn(() => Promise.resolve());

beforeEach(() => {
  closeTerminal.mockClear();
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  const sessions: Record<string, Session> = {};
  for (let i = 0; i < 4; i++) sessions[`s${i}`] = session(`s${i}`, `task-${i}`);
  useDesk.setState({ sessions, hub: { closeTerminal } as never, openId: null });
  useTerminals.setState({ byId: {}, known: true, programs: {}, problems: {} });
});
afterEach(cleanup);

const grid = () => useGrids.getState().grids[MAIN_GRID]!;
const canvas = () => render(<Grid />);
function Grid() {
  const g = useGrids((s) => s.grids[MAIN_GRID]!);
  return (
    <>
      <LayoutUndo gridId={MAIN_GRID} />
      <GridCanvas grid={g} />
    </>
  );
}

describe("a pane's header", () => {
  it("has a remove button that takes a session off the grid without ending it", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, sess("s0"));
    deliver(MAIN_GRID, sess("s1"));
    canvas();
    const pane = screen.getByRole("region", { name: "task-0" });
    const remove = within(pane).getByRole("button", { name: "Remove from grid" });
    expect(remove.getAttribute("title")).toBe("Remove from grid");
    fireEvent.click(remove);
    expect(grid().panes.some((p) => p.content?.kind === "session" && p.content.sessionId === "s0")).toBe(false);
    expect(useDesk.getState().sessions.s0).toBeTruthy();
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  it("asks before closing a terminal with something still running", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "terminal", terminalId: "t1" });
    useTerminals.setState({ programs: { t1: ["zsh", "vim"] } });
    canvas();
    const pane = screen.getAllByRole("region").find((r) => r.dataset.dropPane && within(r).queryByText(/vim/))!;
    fireEvent.click(within(pane).getByRole("button", { name: "Remove from grid" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("vim is still running in it.")).toBeTruthy();
    expect(closeTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    expect(closeTerminal).toHaveBeenCalledWith("t1");
  });
});

describe("a smaller layout", () => {
  it("lists what it parked in a tray, says so with an undo, and swaps one back in on a click", () => {
    layOut(MAIN_GRID, "quarters");
    for (let i = 0; i < 4; i++) deliver(MAIN_GRID, sess(`s${i}`));
    useDesk.setState((s) => ({ sessions: { ...s.sessions, s2: { ...s.sessions.s2!, pending: { kind: "tool", tool: "Bash" } as never } } }));
    canvas();
    act(() => layOut(MAIN_GRID, "one"));
    // s2 needs you, so it stays; the other three park.
    expect(screen.getByRole("status").textContent).toBe("3 items parked · Undo");
    const tray = screen.getByRole("region", { name: "Parked (3)" });
    expect(within(tray).getAllByRole("button", { name: /^task-/ }).map((b) => b.textContent).sort()).toEqual(["task-0", "task-1", "task-3"]);
    expect(within(tray).getByRole("button", { name: "Remove task-0 from grid" })).toBeTruthy();
    act(() => fireEvent.click(within(tray).getByRole("button", { name: "task-0" })));
    expect(grid().panes.find((p) => p.rect)!.content).toEqual(sess("s0"));
    // The grid changed since, so it can't be undone any more.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is put back exactly by its undo", () => {
    layOut(MAIN_GRID, "quarters");
    for (let i = 0; i < 4; i++) deliver(MAIN_GRID, sess(`s${i}`));
    const before = structuredClone(grid().panes);
    canvas();
    act(() => layOut(MAIN_GRID, "halves"));
    act(() => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    expect(grid().panes).toEqual(before);
    expect(screen.queryByRole("region", { name: /Parked/ })).toBeNull();
  });
});

describe("dropping a dragged pane", () => {
  it("moves it within its grid by its own id, and to another grid's next free place from its sidebar row", () => {
    layOut(MAIN_GRID, "thirds");
    deliver(MAIN_GRID, { kind: "terminal", terminalId: "t1" });
    deliver(MAIN_GRID, sess("s1"));
    deliver(MAIN_GRID, sess("s2"));
    const [t, , c] = grid().panes;
    dropPane({ gridId: MAIN_GRID, paneId: t!.id }, { kind: "pane", gridId: MAIN_GRID, paneId: c!.id, zone: "top" });
    const moved = grid().panes.find((p) => p.id === t!.id)!;
    expect(moved.content).toEqual({ kind: "terminal", terminalId: "t1" });
    expect(moved.rect).toEqual({ x: 8, y: 0, w: 4, h: 6 });
    // Its own row: nothing to do.
    dropPane({ gridId: MAIN_GRID, paneId: t!.id }, { kind: "row", gridId: MAIN_GRID });
    expect(grid().panes.find((p) => p.id === t!.id)!.rect).toEqual({ x: 8, y: 0, w: 4, h: 6 });
    const other = createGrid();
    dropPane({ gridId: MAIN_GRID, paneId: t!.id }, { kind: "row", gridId: other });
    expect(grid().panes.some((p) => p.content?.kind === "terminal")).toBe(false);
    expect(useGrids.getState().grids[other]!.panes[0]!.content).toEqual({ kind: "terminal", terminalId: "t1" });
    expect(closeTerminal).not.toHaveBeenCalled();
  });
});
