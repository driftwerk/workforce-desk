import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../hub/types";
import type { PaneContent } from "./engine";
import { MAIN_GRID } from "./model";
import type { GridStorage } from "./storage";
import { createGrid, deliver, layOut, startGrids, useGrids } from "./store";
import { itemOf, placesOf, shownAt } from "./where";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

const sess = (id: string): PaneContent => ({ kind: "session", sessionId: id });
const term = (id: string): PaneContent => ({ kind: "terminal", terminalId: id });
const paneOf = (c: PaneContent, id = MAIN_GRID) => useGrids.getState().grids[id]!.panes.find((p) => JSON.stringify(p.content) === JSON.stringify(c))!;
const tracked = (id: string, terminalId: string, live = true) => ({ id, terminalId, live }) as unknown as Session;

beforeEach(() => {
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
});

describe("what a pane shows, as a sidebar item", () => {
  it("is the session or agent it holds, or the session running in its terminal", () => {
    const sessions = { s1: tracked("s1", "t1"), s2: tracked("s2", "t2", false) };
    expect(itemOf(sessions, sess("s9"))).toBe("session:s9");
    expect(itemOf(sessions, { kind: "agent", agent: "local/scout" })).toBe("agent:local/scout");
    expect(itemOf(sessions, term("t1"))).toBe("session:s1");
    // Once its session has ended, a terminal is only a terminal.
    expect(itemOf(sessions, term("t2"))).toBeNull();
    expect(itemOf(sessions, null)).toBeNull();
  });
});

describe("where an item is shown", () => {
  it("lists every pane in every grid, its own and the terminal it runs in, parked ones too", () => {
    const sessions = { s1: tracked("s1", "t1") };
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, sess("s1"));
    const other = createGrid();
    deliver(other, term("t1"));
    useGrids.setState((s) => ({ grids: { ...s.grids, [other]: { ...s.grids[other]!, placement: { kind: "window", mode: "fill", monitor: null } } } }));
    expect(placesOf(useGrids.getState(), sessions, "session:s1")).toEqual([
      { gridId: MAIN_GRID, paneId: paneOf(sess("s1")).id, content: sess("s1"), parked: false },
      { gridId: other, paneId: paneOf(term("t1"), other).id, content: term("t1"), parked: false },
    ]);
    // s0 has focus, so a smaller layout keeps it and parks s1.
    deliver(MAIN_GRID, sess("s0"));
    layOut(MAIN_GRID, "one");
    expect(placesOf(useGrids.getState(), sessions, "session:s1")[0]).toMatchObject({ gridId: MAIN_GRID, parked: true });
    expect(placesOf(useGrids.getState(), sessions, "session:s2")).toEqual([]);
  });

  it("is seen where it's laid out, not parked or in a window that's closed", () => {
    layOut(MAIN_GRID, "nine");
    for (let i = 0; i < 9; i++) deliver(MAIN_GRID, sess(`s${i}`));
    const other = createGrid();
    deliver(other, sess("x"));
    const at = (item: string) => shownAt(useGrids.getState(), {}, item);
    expect(at("session:s3")).toMatchObject({ gridId: MAIN_GRID, paneId: paneOf(sess("s3")).id });
    expect(at("session:x")).toMatchObject({ gridId: other, paneId: paneOf(sess("x"), other).id });
    useGrids.setState((s) => ({ grids: { ...s.grids, [other]: { ...s.grids[other]!, placement: { kind: "window", mode: "fill", monitor: null } } } }));
    expect(at("session:x")).toBeNull();
    useGrids.setState({ open: { [other]: true } });
    expect(at("session:x")?.gridId).toBe(other);
    useGrids.setState({ active: MAIN_GRID });
    layOut(MAIN_GRID, "one");
    expect(at("session:s3")).toBeNull();
  });

  it("is shown by a pane of its own before the terminal it runs in, the shown grid first", () => {
    const sessions = { s1: tracked("s1", "t1") };
    const other = createGrid();
    deliver(other, term("t1"));
    useGrids.setState({ active: other });
    expect(shownAt(useGrids.getState(), sessions, "session:s1")).toMatchObject({ gridId: other, content: term("t1") });
    deliver(MAIN_GRID, sess("s1"));
    expect(shownAt(useGrids.getState(), sessions, "session:s1")).toMatchObject({ gridId: MAIN_GRID, content: sess("s1") });
  });
});
