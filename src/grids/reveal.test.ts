import { emitTo } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { laidOut, type PaneContent } from "./engine";
import { MAIN_GRID, windowLabel } from "./model";
import type { GridStorage } from "./storage";
import { createGrid, deliver, layOut, startGrids, useGrids } from "./store";
import { goTo, pointOut, reveal } from "./windows";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()), emit: vi.fn(() => Promise.resolve()) }));

const kept = new Map<string, unknown>();
const memory = (): GridStorage =>
  ({ get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} }) as GridStorage;

beforeEach(() => {
  kept.clear();
  useDesk.setState({ view: "rooms", sessions: {}, openId: null });
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
});

describe("showing a session from the sidebar", () => {
  it("finds a claude started in a grid's terminal by that terminal's pane", () => {
    const grid = createGrid();
    deliver(grid, { kind: "terminal", terminalId: "t1" });
    useDesk.setState({ sessions: { s1: { id: "s1", terminalId: "t1", live: true } as unknown as Session } });

    expect(reveal({ kind: "session", sessionId: "s1" })).toBe(true);
    expect(useDesk.getState().view).toBe("grids");
    expect(useGrids.getState().active).toBe(grid);
  });

  it("still opens as usual when the session isn't in any grid", () => {
    createGrid();
    useDesk.setState({ sessions: { s2: { id: "s2", terminalId: null } as unknown as Session } });
    expect(reveal({ kind: "session", sessionId: "s2" })).toBe(false);
    expect(useDesk.getState().view).toBe("rooms");
  });
});

describe("going to a parked pane in a grid's own window", () => {
  const own: PaneContent = { kind: "session", sessionId: "s1" };
  /** Grid "Ops" in a window of its own, open, with s1 parked: s2 has focus,
   *  so the smaller layout keeps it. */
  const parkedInOps = () => {
    const ops = createGrid();
    layOut(ops, "halves");
    deliver(ops, own);
    deliver(ops, { kind: "session", sessionId: "s2" });
    layOut(ops, "one");
    useGrids.setState((s) => ({ grids: { ...s.grids, [ops]: { ...s.grids[ops]!, placement: { kind: "window", mode: "fill", monitor: null } } }, open: { [ops]: true } }));
    return ops;
  };
  const paneOf = (gridId: string) => useGrids.getState().grids[gridId]!.panes.find((p) => p.content?.kind === "session" && p.content.sessionId === "s1")!;

  it("leaves the swap to that window: the main window only asks it to point the pane out", () => {
    const ops = parkedInOps();
    const before = useGrids.getState().grids[ops];
    vi.mocked(emitTo).mockClear();
    expect(goTo({ gridId: ops, paneId: paneOf(ops).id, content: own, parked: true })).toBe(true);
    expect(useGrids.getState().grids[ops]).toBe(before);
    expect(emitTo).toHaveBeenCalledWith(windowLabel(ops), "grid-flash", { gridId: ops, content: own });
  });

  it("swaps it into the layout there, focused and pointed out", () => {
    const ops = parkedInOps();
    useGrids.setState({ role: { kind: "grid", gridId: ops } });
    expect(pointOut(ops, own)).toBe(true);
    const pane = paneOf(ops);
    expect(laidOut(useGrids.getState().grids[ops]!.panes).map((p) => p.id)).toEqual([pane.id]);
    expect(useGrids.getState().focus[ops]).toBe(pane.id);
    expect(useGrids.getState().flash).toMatchObject({ gridId: ops, paneIds: [pane.id] });
  });
});
