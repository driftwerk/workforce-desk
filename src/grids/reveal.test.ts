import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { MAIN_GRID } from "./model";
import type { GridStorage } from "./storage";
import { createGrid, deliver, startGrids, useGrids } from "./store";
import { reveal } from "./windows";

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
