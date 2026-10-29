import { beforeEach, describe, expect, it, vi } from "vitest";
import { HubError } from "../hub/client";
import { presetOf } from "./engine";
import { gridKey, INDEX_KEY, MAIN_GRID, type Grid } from "./model";
import { KeptState, memoryLocalState, stateRows, type HubState } from "./storage";
import { createGrid, layOut, newTerminal, setPlacement, setTerminal, startGrids, useGrids } from "./store";

/** A hub with a Desk state store, in memory. */
const fakeHub = () => {
  const rows = new Map<string, unknown>();
  const hub: HubState & { rows: Map<string, unknown> } = {
    rows,
    list: async (prefix) => [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value, updatedAt: "t" })),
    put: async (key, value) => {
      rows.set(key, structuredClone(value));
      return { updatedAt: "t" };
    },
    remove: async (key) => void rows.delete(key),
  };
  return hub;
};

/** A hub without one: every route answers that it doesn't have it. */
const oldHub: HubState = {
  list: () => Promise.reject(new HubError(404, "This hub doesn’t have that yet.")),
  put: () => Promise.reject(new HubError(404, "This hub doesn’t have that yet.")),
  remove: () => Promise.reject(new HubError(404, "This hub doesn’t have that yet.")),
};

const bus = { deliver: vi.fn() };

beforeEach(() => {
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {} });
});

describe("kept state", () => {
  it("reaches the hub and comes back from it on a Mac that kept nothing", async () => {
    const hub = fakeHub();
    const a = new KeptState(memoryLocalState(), "grid.", undefined, 0);
    await a.connect(hub);
    a.set("grid.x", { panes: [1, 2] });
    a.set("other.y", 1);
    await a.flush();
    expect(hub.rows.get("grid.x")).toEqual({ panes: [1, 2] });

    const b = new KeptState(memoryLocalState(), "grid.", undefined, 0);
    expect(b.get("grid.x")).toBeUndefined();
    await b.connect(hub);
    expect(b.get("grid.x")).toEqual({ panes: [1, 2] });
  });

  it("keeps everything on this Mac while the hub has no state store, and sends it once it has", async () => {
    const local = memoryLocalState();
    const a = new KeptState(local, "grid.", undefined, 0);
    await a.connect(oldHub);
    expect(a.hubHas).toBe("no");
    a.set("grid.x", { n: 1 });
    await a.flush();

    // Desk quits and starts again: the file has it, marked as not yet on a hub.
    const b = new KeptState(memoryLocalState(local.all), "grid.", undefined, 0);
    expect(b.get("grid.x")).toEqual({ n: 1 });
    const hub = fakeHub();
    await b.connect(hub);
    expect(hub.rows.get("grid.x")).toEqual({ n: 1 });
  });

  it("takes the hub's newer value unless this one hasn't reached it", async () => {
    const hub = fakeHub();
    hub.rows.set("grid.kept", { v: "hub" });
    hub.rows.set("grid.changed", { v: "hub" });
    const local = memoryLocalState({
      "grid.kept": { value: { v: "old" }, dirty: false },
      "grid.changed": { value: { v: "mine" }, dirty: true },
    });
    const s = new KeptState(local, "grid.", undefined, 0);
    const heard = vi.fn();
    s.watch("grid.kept", heard);
    await s.connect(hub);
    expect(s.get("grid.kept")).toEqual({ v: "hub" });
    expect(heard).toHaveBeenCalledWith({ v: "hub" });
    expect(s.get("grid.changed")).toEqual({ v: "mine" });
    expect(hub.rows.get("grid.changed")).toEqual({ v: "mine" });
  });

  it("hears another window's change and a removal, and tells other windows its own", async () => {
    const announced: [string, unknown][] = [];
    const s = new KeptState(memoryLocalState(), "grid.", (k, v) => announced.push([k, v]), 0);
    const f = vi.fn();
    s.watch("grid.a", f);
    s.heard("grid.a", { n: 2 });
    expect(f).toHaveBeenLastCalledWith({ n: 2 });
    s.heard("grid.a", null);
    expect(f).toHaveBeenLastCalledWith(null);
    expect(s.get("grid.a")).toBeUndefined();
    s.set("grid.b", 1);
    s.remove("grid.b");
    expect(announced).toEqual([
      ["grid.b", 1],
      ["grid.b", null],
    ]);
  });

  it("reads the hub's listing in the shapes it may take", () => {
    expect(stateRows([{ key: "a", value: 1, updated_at: "t" }])).toEqual([{ key: "a", value: 1, updatedAt: "t" }]);
    expect(stateRows({ entries: [{ key: "a", value: null }] })).toEqual([{ key: "a", value: null, updatedAt: null }]);
    expect(() => stateRows("<html>")).toThrow(HubError);
  });
});

describe("grids, kept", () => {
  it("come back as they were: grids, panes, what they hold, window mode and monitor", async () => {
    const hub = fakeHub();
    const first = new KeptState(memoryLocalState(), "grid.", undefined, 0);
    await first.connect(hub);
    startGrids(first, { kind: "main" }, bus);
    expect(useGrids.getState().order).toEqual([MAIN_GRID]);

    layOut(MAIN_GRID, "quarters");
    newTerminal(MAIN_GRID);
    const pane = useGrids.getState().grids[MAIN_GRID]!.panes.find((p) => p.content?.kind === "terminal")!;
    setTerminal(MAIN_GRID, pane.id, "term-1", "/work/acme-web");
    layOut(MAIN_GRID, "quarters", { slot: 1, content: { kind: "session", sessionId: "s-1" } });
    const release = createGrid();
    layOut(release, "focus", { slot: 0, content: { kind: "agent", agent: "local/atlas" } });
    setPlacement(release, {
      kind: "window",
      mode: "fullscreen",
      monitor: { id: "Studio Display:5120x2880@2", name: "Studio Display", origin: [1512, 0] },
      frame: null,
    });
    await first.flush();
    const before = structuredClone(useGrids.getState().grids) as Record<string, Grid>;
    const order = useGrids.getState().order;

    // Another Mac's worth of nothing: everything comes from the hub.
    useGrids.setState({ ready: false, order: [], grids: {} });
    const again = new KeptState(memoryLocalState(), "grid.", undefined, 0);
    await again.connect(hub);
    startGrids(again, { kind: "main" }, bus);
    const after = useGrids.getState();
    expect(after.order).toEqual(order);
    expect(after.grids).toEqual(before);
    expect(presetOf(after.grids[release]!.panes)).toBe("focus");
    expect(after.grids[MAIN_GRID]!.panes.map((p) => p.content)).toContainEqual({ kind: "terminal", terminalId: "term-1", cwd: "/work/acme-web" });
    expect(after.grids[release]!.placement).toMatchObject({ kind: "window", mode: "fullscreen", monitor: { name: "Studio Display" } });
    expect(hub.rows.has(INDEX_KEY) && hub.rows.has(gridKey(release))).toBe(true);
  });

  it("a detached window changes only its own grid", async () => {
    const s = new KeptState(memoryLocalState(), "grid.", undefined, 0);
    startGrids(s, { kind: "main" }, bus);
    const other = createGrid();
    startGrids(s, { kind: "grid", gridId: other }, bus);
    const main = structuredClone(useGrids.getState().grids[MAIN_GRID]);
    layOut(MAIN_GRID, "nine");
    expect(useGrids.getState().grids[MAIN_GRID]).toEqual(main);
    layOut(other, "halves");
    expect(presetOf(useGrids.getState().grids[other]!.panes)).toBe("halves");
  });
});
