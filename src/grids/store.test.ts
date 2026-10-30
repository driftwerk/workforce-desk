import { beforeEach, describe, expect, it, vi } from "vitest";
import { presetOf, type Pane, type PaneContent } from "./engine";
import { MAIN_GRID } from "./model";
import type { GridStorage } from "./storage";
import {
  createGrid,
  deliver,
  layOut,
  movePane,
  movePaneWithin,
  renameGrid,
  setAskingCheck,
  setFocus,
  startGrids,
  swapInPane,
  undoFor,
  undoLayout,
  useGrids,
} from "./store";

/** A storage with nothing behind it but a map. */
const memory = (): GridStorage & { kept: Map<string, unknown> } => {
  const kept = new Map<string, unknown>();
  return {
    kept,
    get: (k) => kept.get(k),
    set: (k, v) => void kept.set(k, structuredClone(v)),
    remove: (k) => void kept.delete(k),
    subscribe: () => () => {},
  } as GridStorage & { kept: Map<string, unknown> };
};

const bus = { deliver: vi.fn(), rename: vi.fn() };
const sess = (id: string): PaneContent => ({ kind: "session", sessionId: id });
const term = (id: string): PaneContent => ({ kind: "terminal", terminalId: id });
const panes = (id = MAIN_GRID) => useGrids.getState().grids[id]!.panes;
const pane = (c: PaneContent, id = MAIN_GRID) => panes(id).find((p) => JSON.stringify(p.content) === JSON.stringify(c))!;

let store: ReturnType<typeof memory>;
beforeEach(() => {
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  setAskingCheck(() => []);
  bus.deliver.mockClear();
  bus.rename.mockClear();
  store = memory();
  startGrids(store, { kind: "main" }, bus);
});

/** Main as a 3 × 3 of sessions s0…s8. */
const nine = () => {
  layOut(MAIN_GRID, "nine");
  for (let i = 0; i < 9; i++) deliver(MAIN_GRID, sess(`s${i}`));
};

describe("moving panes in a grid", () => {
  it("keeps the moved pane's id, so a terminal carries on, and swaps in the middle", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, term("t1"));
    deliver(MAIN_GRID, sess("s1"));
    const t = pane(term("t1"));
    const s = pane(sess("s1"));
    expect(movePaneWithin(MAIN_GRID, t.id, s.id, "center")).toBe(true);
    expect(pane(term("t1")).id).toBe(t.id);
    expect(pane(term("t1")).rect).toEqual(s.rect);
    expect(pane(sess("s1")).rect).toEqual(t.rect);
    expect(useGrids.getState().focus[MAIN_GRID]).toBe(t.id);
  });

  it("moves to another grid through that grid's first free place", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, term("t1"));
    const other = createGrid();
    layOut(other, "halves");
    deliver(other, sess("s9"));
    movePane(MAIN_GRID, pane(term("t1")).id, other);
    expect(panes().some((p) => p.content)).toBe(false);
    expect(pane(term("t1"), other).rect).toEqual({ x: 6, y: 0, w: 6, h: 12 });
  });
});

describe("a smaller layout", () => {
  it("keeps what needs you and the focused pane, and can be undone exactly", () => {
    nine();
    setAskingCheck((ps) => ps.filter((p) => JSON.stringify(p.content) === JSON.stringify(sess("s7"))).map((p) => p.id));
    setFocus(MAIN_GRID, pane(sess("s4")).id);
    const before = structuredClone(panes());
    layOut(MAIN_GRID, "halves");
    expect(presetOf(panes())).toBe("halves");
    const shown = panes().filter((p) => p.rect).map((p) => (p.content as { sessionId: string }).sessionId).sort();
    expect(shown).toEqual(["s4", "s7"]);
    expect(undoFor(useGrids.getState(), MAIN_GRID)?.parked).toBe(7);
    undoLayout(MAIN_GRID);
    expect(panes()).toEqual(before);
    expect(undoFor(useGrids.getState(), MAIN_GRID)).toBeNull();
  });

  it("offers no undo once the grid has changed since, nor when nothing parked", () => {
    nine();
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, sess("new"));
    expect(undoFor(useGrids.getState(), MAIN_GRID)).toBeNull();
    layOut(MAIN_GRID, "nine");
    expect(useGrids.getState().undo[MAIN_GRID]).toBeUndefined();
  });

  it("remembers which panes were active last, with the grid, and brings them back first", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    nine();
    for (const [i, s] of ["s3", "s2", "s5"].entries()) {
      vi.setSystemTime(1000 + i);
      setFocus(MAIN_GRID, pane(sess(s)).id);
    }
    vi.useRealTimers();
    expect((store.kept.get(`grid.${MAIN_GRID}`) as { panes: Pane[] }).panes.find((p) => p.id === pane(sess("s5")).id)!.lastActive).toBe(1002);
    layOut(MAIN_GRID, "one");
    layOut(MAIN_GRID, "quarters");
    const shown = panes().filter((p) => p.rect).map((p) => (p.content as { sessionId: string }).sessionId);
    // s5 (focused), then the parked by when they were active: s2, s3, then s0.
    expect(shown.sort()).toEqual(["s0", "s2", "s3", "s5"]);
  });

  it("swaps a parked pane in, parking the least recently active", () => {
    nine();
    layOut(MAIN_GRID, "halves");
    const parked = panes().find((p) => !p.rect)!;
    expect(swapInPane(MAIN_GRID, parked.id)).toBe(true);
    expect(panes().find((p) => p.id === parked.id)!.rect).not.toBeNull();
    expect(panes().filter((p) => !p.rect)).toHaveLength(7);
  });
});

describe("grids from the sidebar", () => {
  it("renames a grid here, or asks the window that writes it", () => {
    renameGrid(MAIN_GRID, "  Release ");
    expect(useGrids.getState().grids[MAIN_GRID]!.name).toBe("Release");
    const other = createGrid();
    useGrids.setState((s) => ({
      open: { [other]: true },
      grids: { ...s.grids, [other]: { ...s.grids[other]!, placement: { kind: "window", mode: "fill", monitor: null } } },
    }));
    renameGrid(other, "Ops");
    expect(bus.rename).toHaveBeenCalledWith(other, "Ops");
    renameGrid(MAIN_GRID, "   ");
    expect(useGrids.getState().grids[MAIN_GRID]!.name).toBe("Release");
  });
});
