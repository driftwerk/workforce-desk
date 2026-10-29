// The grids this window knows, kept in step with where they're stored.
//
// Each grid has one writer at a time — the window showing it: Desk's main
// window for grids shown there (and for detached grids whose monitor is
// away), the grid's own window otherwise. A pane sent to a grid this window
// doesn't show goes to its writer (see `deliver`), so two windows never
// write the same grid at once.

import { create } from "zustand";
import {
  applyPreset,
  blank,
  close,
  findContent,
  laidOut,
  moveSplitter,
  place,
  presetById,
  reading,
  replace,
  split,

  type Pane,
  type PaneContent,
  type PresetId,
  type Side,
  type Splitter,
} from "./engine";
import { gridKey, INDEX_KEY, MAIN_GRID, mainGrid, newId, nextName, paneId, readGrid, readIndex, type Grid, type Placement } from "./model";
import type { GridStorage } from "./storage";

/** Which window this is: Desk's main window, or a detached grid's. */
export type Role = { kind: "main" } | { kind: "grid"; gridId: string };

/** How panes reach a grid another window writes. */
export interface GridBus {
  /** Sends `content` to grid `gridId`'s writer, which places it. */
  deliver(gridId: string, content: PaneContent): void;
}

interface GridsState {
  ready: boolean;
  role: Role;
  order: string[];
  grids: Record<string, Grid>;
  /** The grid the main window's Grids view shows. */
  active: string;
  /** The pane last clicked or focused, by grid. */
  focus: Record<string, string>;
  /** Detached grids whose window is open now (the main window keeps this). */
  open: Record<string, true>;
}

export const useGrids = create<GridsState>(() => ({
  ready: false,
  role: { kind: "main" },
  order: [],
  grids: {},
  active: MAIN_GRID,
  focus: {},
  open: {},
}));

let storage: GridStorage | null = null;
let bus: GridBus | null = null;
const unwatch = new Map<string, () => void>();

const get = () => useGrids.getState();

/** Whether this window writes grid `id`. */
export const writes = (id: string, s: GridsState = get()): boolean => {
  const g = s.grids[id];
  if (!g) return false;
  if (s.role.kind === "grid") return s.role.gridId === id;
  return g.placement.kind === "main" || !s.open[id];
};

const watchGrid = (id: string) => {
  if (!storage || unwatch.has(id)) return;
  unwatch.set(
    id,
    storage.watch(gridKey(id), (v) => {
      const g = readGrid(v);
      useGrids.setState((s) => {
        if (!g) {
          const { [id]: _gone, ...rest } = s.grids;
          return { grids: rest };
        }
        return { grids: { ...s.grids, [id]: g } };
      });
    }),
  );
};

const readAll = (order: string[]): Record<string, Grid> => {
  const grids: Record<string, Grid> = {};
  for (const id of order) {
    const g = readGrid(storage?.get(gridKey(id)));
    if (g) grids[id] = g;
  }
  return grids;
};

/** Starts keeping grids in `store`. The main window makes Main if there are
 *  no grids yet. */
export const startGrids = (store: GridStorage, role: Role, deliverer: GridBus): void => {
  storage = store;
  bus = deliverer;
  for (const u of unwatch.values()) u();
  unwatch.clear();
  let order = readIndex(store.get(INDEX_KEY)) ?? [];
  let grids = readAll(order);
  if (role.kind === "main" && !grids[MAIN_GRID] && !order.length) {
    const main = mainGrid();
    grids = { [MAIN_GRID]: main };
    order = [MAIN_GRID];
    store.set(gridKey(MAIN_GRID), main);
    store.set(INDEX_KEY, { order });
  }
  order = order.filter((id) => grids[id]);
  const active = order.includes(get().active) ? get().active : (order.find((id) => grids[id]!.placement.kind === "main") ?? order[0] ?? MAIN_GRID);
  useGrids.setState({ ready: true, role, order, grids, active });
  for (const id of order) watchGrid(id);
  unwatch.set(
    INDEX_KEY,
    store.watch(INDEX_KEY, (v) => {
      const next = readIndex(v) ?? [];
      const fresh = readAll(next.filter((id) => !get().grids[id]));
      useGrids.setState((s) => ({ order: next, grids: { ...s.grids, ...fresh } }));
      for (const id of next) watchGrid(id);
    }),
  );
};

const save = (g: Grid) => storage?.set(gridKey(g.id), g);

/** Changes grid `id` (if this window writes it). */
export const changeGrid = (id: string, f: (g: Grid) => Grid): void => {
  const g = get().grids[id];
  if (!g || !writes(id)) return;
  const next = f(g);
  if (next === g) return;
  useGrids.setState((s) => ({ grids: { ...s.grids, [id]: next } }));
  save(next);
};

export const changePanes = (id: string, f: (panes: Pane[]) => Pane[] | null): boolean => {
  let done = false;
  changeGrid(id, (g) => {
    const panes = f(g.panes);
    if (!panes) return g;
    done = true;
    return { ...g, panes };
  });
  return done;
};

export const setFocus = (gridId: string, pane: string): void =>
  void (get().focus[gridId] !== pane && useGrids.setState((s) => ({ focus: { ...s.focus, [gridId]: pane } })));

export const setActive = (id: string): void => useGrids.setState({ active: id });

const saveOrder = (order: string[]) => {
  useGrids.setState({ order });
  storage?.set(INDEX_KEY, { order });
};

/** A new grid in the main window, shown there. */
export const createGrid = (): string => {
  const id = newId();
  const g: Grid = { id, name: nextName(Object.values(get().grids)), panes: blank(paneId), placement: { kind: "main" } };
  useGrids.setState((s) => ({ grids: { ...s.grids, [id]: g }, active: id }));
  save(g);
  watchGrid(id);
  saveOrder([...get().order, id]);
  return id;
};

export const renameGrid = (id: string, name: string): void => {
  const n = name.trim();
  if (n) changeGrid(id, (g) => ({ ...g, name: n }));
};

/** Forgets grid `id` (never the last one); `onContent` hears of each thing
 *  it held, to close what the hub hosts for it. */
export const deleteGrid = (id: string, onContent: (c: PaneContent) => void): void => {
  const s = get();
  if (s.order.length <= 1 || !s.grids[id]) return;
  for (const p of s.grids[id]!.panes) if (p.content) onContent(p.content);
  unwatch.get(id)?.();
  unwatch.delete(id);
  const order = s.order.filter((x) => x !== id);
  const { [id]: _gone, ...grids } = s.grids;
  useGrids.setState({ grids, active: s.active === id ? (order.find((x) => grids[x]?.placement.kind === "main") ?? order[0]!) : s.active });
  storage?.remove(gridKey(id));
  saveOrder(order);
};

export const setPlacement = (id: string, placement: Placement): void => changeGrid(id, (g) => ({ ...g, placement }));

/** The main window's record of which detached grids have a window. */
export const setOpen = (id: string, open: boolean): void =>
  useGrids.setState((s) => {
    if (!!s.open[id] === open) return s;
    const { [id]: _was, ...rest } = s.open;
    return { open: open ? { ...rest, [id]: true } : rest };
  });

// ── Pane operations ────────────────────────────────────────────────────────

/** Lays grid `id` out as a preset; with `insert`, `content` takes place `slot`. */
export const layOut = (id: string, preset: PresetId, insert?: { slot: number; content: PaneContent }): void => {
  changePanes(id, (panes) => {
    const base = insert ? withoutParked(panes, insert.content) : panes;
    return applyPreset(base, presetById(preset), paneId, insert && { slot: insert.slot, pane: { id: paneId(), rect: null, content: insert.content } });
  });
  if (insert) focusContent(id, insert.content);
};

/** `content` out of the panes wherever it is: a laid-out pane is emptied
 *  (so the layout doesn't shift under a drop), a parked one goes. */
const withoutParked = (panes: Pane[], content: PaneContent): Pane[] => {
  const there = findContent(panes, content);
  if (!there) return panes;
  return there.rect ? replace(panes, there.id, null) : panes.filter((p) => p.id !== there.id);
};

const focusContent = (gridId: string, content: PaneContent) => {
  const p = findContent(get().grids[gridId]?.panes ?? [], content);
  if (p) setFocus(gridId, p.id);
};

/** Drops `content` on pane `paneId`: a side splits it, the middle replaces
 *  what it holds. Already in the grid, it moves. */
export const dropOnPane = (gridId: string, target: string, zone: Side | "center", content: PaneContent, onReplaced?: (c: PaneContent) => void): void => {
  const panes = get().grids[gridId]?.panes;
  const there = panes && findContent(panes, content);
  if (!panes || there?.id === target) return;
  changePanes(gridId, (all) => {
    if (zone === "center") {
      const old = all.find((p) => p.id === target)?.content;
      if (old && onReplaced) onReplaced(old);
      const moved = there ? (there.rect ? close(all, there.id) : all.filter((p) => p.id !== there.id)) : all;
      return replace(moved, target, content);
    }
    const id = paneId();
    const done = split(all, target, zone, { id, content });
    if (!done) return null;
    return there ? close(done, there.id) : done;
  });
  focusContent(gridId, content);
};

/** Puts `content` in grid `gridId` without snapping: the first empty pane,
 *  else a split of the largest. Delivered to the grid's writer when that's
 *  another window. */
export const deliver = (gridId: string, content: PaneContent): void => {
  if (!writes(gridId)) {
    bus?.deliver(gridId, content);
    return;
  }
  changePanes(gridId, (panes) => {
    if (findContent(panes, content)) return null;
    return place(panes, { id: paneId(), content });
  });
  focusContent(gridId, content);
};

/** Takes pane `paneId` out of the grid; what it held is passed on. */
export const closePane = (gridId: string, pane: string, onContent?: (c: PaneContent) => void): void => {
  const p = get().grids[gridId]?.panes.find((x) => x.id === pane);
  if (p?.content && onContent) onContent(p.content);
  changePanes(gridId, (panes) => close(panes, pane));
};

export const replacePane = (gridId: string, pane: string, content: PaneContent | null, onReplaced?: (c: PaneContent) => void): void => {
  const p = get().grids[gridId]?.panes.find((x) => x.id === pane);
  if (p?.content && onReplaced) onReplaced(p.content);
  changePanes(gridId, (panes) => {
    const there = content && findContent(panes, content);
    const moved = there && there.id !== pane ? (there.rect ? close(panes, there.id) : panes.filter((x) => x.id !== there.id)) : panes;
    return replace(moved, pane, content);
  });
  setFocus(gridId, pane);
};

/** Moves pane `paneId`'s content to grid `to` (its pane here closes). */
export const movePane = (from: string, pane: string, to: string): void => {
  const p = get().grids[from]?.panes.find((x) => x.id === pane);
  if (!p?.content || from === to) return;
  const content = p.content;
  changePanes(from, (panes) => close(panes, pane));
  deliver(to, content);
};

export const dragSplitter = (gridId: string, s: Splitter, at: number): void => void changePanes(gridId, (panes) => moveSplitter(panes, s, at));

/** A new terminal in grid `gridId`: in the focused pane if it's empty, else
 *  the first empty pane, else beside the focused pane. */
export const newTerminal = (gridId: string): void => {
  const g = get().grids[gridId];
  if (!g) return;
  const content: PaneContent = { kind: "terminal", terminalId: null };
  const shown = reading(laidOut(g.panes));
  const focused = shown.find((p) => p.id === get().focus[gridId]);
  const target = focused && !focused.content ? focused : shown.find((p) => !p.content);
  if (target) {
    replacePane(gridId, target.id, content);
    return;
  }
  const id = paneId();
  const done =
    focused &&
    changePanes(gridId, (panes) => {
      const wide = focused.rect.w * 1.2 >= focused.rect.h;
      return split(panes, focused.id, wide ? "right" : "bottom", { id, content }) ?? split(panes, focused.id, wide ? "bottom" : "right", { id, content });
    });
  if (done) setFocus(gridId, id);
  else if (changePanes(gridId, (panes) => place(panes, { id, content }))) setFocus(gridId, id);
};

/** A terminal pane's hub id, once the hub has opened it (or opened it again). */
export const setTerminal = (gridId: string, pane: string, terminalId: string, cwd?: string | null): void =>
  void changePanes(gridId, (panes) =>
    panes.map((p) => (p.id === pane && p.content?.kind === "terminal" ? { ...p, content: { kind: "terminal", terminalId, cwd: cwd ?? p.content.cwd ?? null } } : p)),
  );

