import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropOnGrid, endGridDrag, moveGridDrag, startGridDrag } from "./drag";
import { GridsMain } from "./Grids";
import { MAIN_GRID } from "./model";
import type { GridStorage } from "./storage";
import { createGrid, deleteGrid, newTerminalHere, setPlacement, startGrids, useGrids } from "./store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

afterEach(cleanup);

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

beforeEach(() => {
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: null, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  deleteGrid(MAIN_GRID, () => {});
});

const laidOut = (id: string) => useGrids.getState().grids[id]!.panes.filter((p) => p.rect).map((p) => p.content);

describe("the Grids view with no grids", () => {
  it("says so, and offers a new grid", () => {
    render(<GridsMain />);
    expect(screen.getByText("No grids yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New grid" }));
    expect(useGrids.getState().order).toHaveLength(1);
    expect(screen.queryByText("No grids yet")).toBeNull();
  });

  it("makes a grid holding a session or agent dropped on it", () => {
    render(<GridsMain />);
    const view = screen.getByRole("main", { name: "Grids" });
    document.elementsFromPoint = () => [view];
    act(() => startGridDrag({ kind: "session", sessionId: "s1" }, "api-e7"));
    expect(screen.getByText("Drop it here for a new grid.")).toBeTruthy();
    act(() => void moveGridDrag(40, 40));
    expect(view.classList.contains("drop-in")).toBe(true);
    const done = endGridDrag(false)!;
    expect(done.target).toEqual({ kind: "new" });
    act(() => dropOnGrid(done.target, done.content));
    const [id] = useGrids.getState().order;
    expect(laidOut(id!)).toEqual([{ kind: "session", sessionId: "s1" }]);
    expect(useGrids.getState().active).toBe(id);
  });

  it("⌘T makes a grid with a terminal in it", () => {
    newTerminalHere();
    const [id] = useGrids.getState().order;
    expect(laidOut(id!)).toEqual([{ kind: "terminal", terminalId: null }]);
    // Another goes in the same grid.
    newTerminalHere();
    expect(useGrids.getState().order).toEqual([id]);
    expect(laidOut(id!)).toHaveLength(2);
  });

  it("⌘T with every grid in a window of its own makes one here, rather than reaching into another window", () => {
    const away = createGrid();
    setPlacement(away, { kind: "window", mode: "fill", monitor: null });
    useGrids.setState({ open: { [away]: true } });
    newTerminalHere();
    const order = useGrids.getState().order;
    expect(order).toHaveLength(2);
    expect(laidOut(order[1]!)).toEqual([{ kind: "terminal", terminalId: null }]);
    expect(laidOut(away)).toEqual([null]);
  });
});
