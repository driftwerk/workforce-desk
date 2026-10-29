import { beforeEach, describe, expect, it, vi } from "vitest";
import { HubError } from "../hub/client";
import { DeskStateStore, stable, type HubState, type LocalState, type StateEntry } from "../restore/store";
import { presetOf } from "./engine";
import { gridKey, INDEX_KEY, MAIN_GRID, type Grid } from "./model";
import { GRID_PREFIX } from "./storage";
import { createGrid, layOut, newTerminal, setPlacement, setTerminal, startGrids, useGrids } from "./store";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

/** Desk's file, as its native side keeps it (adopt refuses a dirty key). */
const fakeFile = (initial: Record<string, StateEntry> = {}) => {
  const entries: Record<string, StateEntry> = structuredClone(initial);
  const local: LocalState & { entries: typeof entries } = {
    entries,
    load: async () => structuredClone(entries),
    put: async (key, value) => void (entries[key] = { value: structuredClone(value), updatedAt: null, dirty: true }),
    remove: async (key) => void delete entries[key],
    synced: async (key, value, updatedAt) => {
      if (entries[key] && stable(entries[key].value) === stable(value)) entries[key] = { value, updatedAt, dirty: false };
    },
    adopt: async (key, value, updatedAt) => {
      if (entries[key]?.dirty) return false;
      if (value === null) delete entries[key];
      else entries[key] = { value, updatedAt, dirty: false };
      return true;
    },
    flush: async () => {},
  };
  return local;
};

/** A hub with a Desk state store, or (`missing`) one without the route. */
const fakeHub = (missing = false) => {
  const kept = new Map<string, unknown>();
  const no = () => new HubError(404, "This hub doesn’t have that yet.");
  const hub: HubState & { kept: typeof kept } = {
    kept,
    list: async (prefix) => {
      if (missing) throw no();
      return [...kept].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value, updatedAt: "t" }));
    },
    put: async (key, value) => {
      if (missing) throw no();
      kept.set(key, structuredClone(value));
      return { updatedAt: "t" };
    },
    remove: async (key) => void kept.delete(key),
  };
  return hub;
};

const bus = { deliver: vi.fn() };

/** A Desk that has just started: its file read, the hub (if any) connected. */
const started = async (file: LocalState, hub: HubState | null) => {
  const store = new DeskStateStore(file, 0);
  await store.load();
  await store.register(GRID_PREFIX);
  await store.connect(hub);
  return store;
};

const blankState = () => useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {} });

beforeEach(blankState);

/** Lays out a few grids the way someone would: a terminal, a session, an
 *  agent, and a grid in its own window, full screen, on a named monitor. */
const arrange = () => {
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
  });
  return release;
};

describe("grids, kept", () => {
  it("come back from the hub on a Mac that kept nothing: grids, panes, what they hold, window mode and monitor", async () => {
    const hub = fakeHub();
    const first = await started(fakeFile(), hub);
    startGrids(first, { kind: "main" }, bus);
    expect(useGrids.getState().order).toEqual([MAIN_GRID]);
    const release = arrange();
    await first.flush();
    const before = structuredClone(useGrids.getState().grids) as Record<string, Grid>;
    const order = useGrids.getState().order;
    expect(hub.kept.has(INDEX_KEY) && hub.kept.has(gridKey(release))).toBe(true);

    blankState();
    startGrids(await started(fakeFile(), hub), { kind: "main" }, bus);
    const after = useGrids.getState();
    expect(after.order).toEqual(order);
    expect(after.grids).toEqual(before);
    expect(presetOf(after.grids[release]!.panes)).toBe("focus");
    expect(after.grids[MAIN_GRID]!.panes.map((p) => p.content)).toContainEqual({ kind: "terminal", terminalId: "term-1", cwd: "/work/acme-web" });
    expect(after.grids[release]!.placement).toMatchObject({ kind: "window", mode: "fullscreen", monitor: { name: "Studio Display" } });
  });

  it("come back from Desk's own file while the hub has no state store", async () => {
    const file = fakeFile();
    const first = await started(file, fakeHub(true));
    startGrids(first, { kind: "main" }, bus);
    arrange();
    const before = structuredClone(useGrids.getState().grids);

    blankState();
    startGrids(await started(fakeFile(file.entries), fakeHub(true)), { kind: "main" }, bus);
    expect(useGrids.getState().grids).toEqual(before);
  });

  it("take a change another Mac made, through the hub", async () => {
    const hub = fakeHub();
    const store = await started(fakeFile(), hub);
    startGrids(store, { kind: "main" }, bus);
    await store.flush();
    const main = useGrids.getState().grids[MAIN_GRID]!;
    const renamed = { ...main, name: "Release" };
    hub.kept.set(gridKey(MAIN_GRID), renamed);
    await store.heard(gridKey(MAIN_GRID), renamed);
    expect(useGrids.getState().grids[MAIN_GRID]!.name).toBe("Release");
  });

  it("a detached window changes only its own grid", async () => {
    const store = await started(fakeFile(), null);
    startGrids(store, { kind: "main" }, bus);
    const other = createGrid();
    startGrids(store, { kind: "grid", gridId: other }, bus);
    const main = structuredClone(useGrids.getState().grids[MAIN_GRID]);
    layOut(MAIN_GRID, "nine");
    expect(useGrids.getState().grids[MAIN_GRID]).toEqual(main);
    layOut(other, "halves");
    expect(presetOf(useGrids.getState().grids[other]!.panes)).toBe("halves");
  });
});
