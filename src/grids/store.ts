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
  findSplitter,
  laidOut,
  movePaneTo,
  moveSplitter,
  place,
  presetById,
  reading,
  replace,
  split,
  swapIn,
  unpark,
  type Pane,
  type PaneContent,
  type PresetId,
  type Side,
  type Splitter,
  type Zone,
} from "./engine";
import { gridKey, INDEX_KEY, MAIN_GRID, mainGrid, newId, nextName, paneId, readGrid, readIndex, type Grid, type Placement } from "./model";
import { GRID_PREFIX, type GridStorage } from "./storage";
import { moved, nudged } from "../ui/reorder";

/** Which window this is: Desk's main window, or a detached grid's. */
export type Role = { kind: "main" } | { kind: "grid"; gridId: string };

/** How panes reach a grid another window writes. */
export interface GridBus {
  /** Sends `content` to grid `gridId`'s writer, which places it. */
  deliver(gridId: string, content: PaneContent): void;
  /** Asks grid `gridId`'s writer to rename it. */
  rename(gridId: string, name: string): void;
}

/** A layout change that parked panes, which can be taken back while the
 *  grid is still as it left it. */
export interface Undo {
  before: Pane[];
  /** The layout it left (see `layoutSig`). */
  after: string;
  parked: number;
}

/** A pane to point out for a moment: `n` counts, so the same pane can be
 *  pointed out again. */
export interface Flash {
  gridId: string;
  paneId: string;
  n: number;
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
  /** By grid: the last layout change that parked panes, while it can be undone. */
  undo: Record<string, Undo>;
  flash: Flash | null;
}

export const useGrids = create<GridsState>(() => ({
  ready: false,
  role: { kind: "main" },
  order: [],
  grids: {},
  active: MAIN_GRID,
  focus: {},
  open: {},
  undo: {},
  flash: null,
}));

let storage: GridStorage | null = null;
let bus: GridBus | null = null;
let stopListening: (() => void) | null = null;
/** Which of these panes are waiting on an approval (the hub's sessions
 *  know; see terminals.ts). */
let askingIn: (panes: readonly Pane[]) => string[] = () => [];

export const setAskingCheck = (f: (panes: readonly Pane[]) => string[]): void => {
  askingIn = f;
};

const get = () => useGrids.getState();

/** Whether this window writes grid `id`. */
export const writes = (id: string, s: GridsState = get()): boolean => {
  const g = s.grids[id];
  if (!g) return false;
  if (s.role.kind === "grid") return s.role.gridId === id;
  return g.placement.kind === "main" || !s.open[id];
};

const readAll = (order: string[]): Record<string, Grid> => {
  const grids: Record<string, Grid> = {};
  for (const id of order) {
    const g = readGrid(storage?.get(gridKey(id)));
    if (g) grids[id] = g;
  }
  return grids;
};

/** A grid key someone else changed — the hub (another Mac, or after a
 *  restart) or another of Desk's windows; null when it was removed. */
export const heardGrid = (key: string, value: unknown): void => {
  if (key === INDEX_KEY) {
    const order = readIndex(value) ?? [];
    const fresh = readAll(order.filter((id) => !get().grids[id]));
    useGrids.setState((s) => ({ order, grids: { ...s.grids, ...fresh } }));
    return;
  }
  if (!key.startsWith(GRID_PREFIX)) return;
  const id = key.slice(GRID_PREFIX.length);
  const g = value === null ? null : readGrid(value);
  useGrids.setState((s) => {
    if (!g) {
      const { [id]: _gone, ...rest } = s.grids;
      return { grids: rest };
    }
    return { grids: { ...s.grids, [id]: g } };
  });
};

/** Starts keeping grids in `store`. The main window makes Main if there are
 *  no grids yet. */
export const startGrids = (store: GridStorage, role: Role, deliverer: GridBus): void => {
  storage = store;
  bus = deliverer;
  stopListening?.();
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
  stopListening = store.subscribe(GRID_PREFIX, (key, value, origin) => {
    if (origin === "hub") heardGrid(key, value);
  });
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

/** Pane `pane` was clicked or focused: it's the grid's focused pane, and
 *  the most recently active (kept with the grid, for which panes a smaller
 *  layout keeps). */
export const setFocus = (gridId: string, pane: string, again = false): void => {
  if (get().focus[gridId] === pane && !again) return;
  useGrids.setState((s) => ({ focus: { ...s.focus, [gridId]: pane } }));
  touch(gridId, pane);
};

/** Pane `pane` was active just now. */
const touch = (gridId: string, pane: string) =>
  changePanes(gridId, (panes) => (panes.some((p) => p.id === pane) ? panes.map((p) => (p.id === pane ? { ...p, lastActive: Date.now() } : p)) : null));

/** Points pane `pane` out for a moment. */
export const flashPane = (gridId: string, paneId: string): void =>
  useGrids.setState((s) => ({ flash: { gridId, paneId, n: (s.flash?.n ?? 0) + 1 } }));

/** Pointing out `n` is over (so a grid shown again doesn't do it again). */
export const flashDone = (n: number): void => void (get().flash?.n === n && useGrids.setState({ flash: null }));

export const setActive = (id: string): void => useGrids.setState({ active: id });

const saveOrder = (order: string[]) => {
  useGrids.setState({ order });
  storage?.set(INDEX_KEY, { order });
};

/** Moves grid `id` before grid `before` (last when null), as the sidebar
 *  lists them; kept in `grid.index`. */
export const moveGrid = (id: string, before: string | null): void => {
  const next = moved(get().order, id, before);
  if (next) saveOrder(next);
};

/** Moves grid `id` one place up or down; false when it's already at that end. */
export const nudgeGrid = (id: string, by: -1 | 1): boolean => {
  const next = nudged(get().order, id, by);
  if (next) saveOrder(next);
  return !!next;
};

/** A new grid in the main window, shown there. */
export const createGrid = (): string => {
  const id = newId();
  const g: Grid = { id, name: nextName(Object.values(get().grids)), panes: blank(paneId), placement: { kind: "main" } };
  useGrids.setState((s) => ({ grids: { ...s.grids, [id]: g }, active: id }));
  save(g);
  saveOrder([...get().order, id]);
  return id;
};

/** Renames grid `id`; a grid another window writes is renamed there. */
export const renameGrid = (id: string, name: string): void => {
  const n = name.trim();
  if (!n || !get().grids[id] || get().grids[id]!.name === n) return;
  if (writes(id)) changeGrid(id, (g) => ({ ...g, name: n }));
  else bus?.rename(id, n);
};

/** Forgets grid `id` (never the last one); `onContent` hears of each thing
 *  it held, to close what the hub hosts for it. */
export const deleteGrid = (id: string, onContent: (c: PaneContent) => void): void => {
  const s = get();
  if (s.order.length <= 1 || !s.grids[id]) return;
  for (const p of s.grids[id]!.panes) if (p.content) onContent(p.content);
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

/** The layout as it is, without when each pane was last active (which
 *  changes as panes are clicked, and doesn't stop an undo). */
export const layoutSig = (panes: readonly Pane[]): string => JSON.stringify(panes.map((p) => [p.id, p.rect, p.content]));

const parkedIds = (panes: readonly Pane[]) => new Set(panes.filter((p) => !p.rect && p.content).map((p) => p.id));

/** Lays grid `id` out as a preset; with `insert`, `content` takes place
 *  `slot`. What doesn't fit parks (see `applyPreset` for which panes stay),
 *  and the change can be undone while the grid is still as it left it. */
export const layOut = (id: string, preset: PresetId, insert?: { slot: number; content: PaneContent }): void => {
  const before = get().grids[id]?.panes;
  changePanes(id, (panes) => {
    const base = insert ? withoutParked(panes, insert.content) : panes;
    const keep = { asking: askingIn(base), focused: get().focus[id] ?? null };
    return applyPreset(base, presetById(preset), paneId, insert && { slot: insert.slot, pane: { id: paneId(), rect: null, content: insert.content } }, keep);
  });
  const after = get().grids[id]?.panes;
  if (before && after && after !== before) {
    const was = parkedIds(before);
    const parked = [...parkedIds(after)].filter((x) => !was.has(x)).length;
    useGrids.setState((s) => {
      const { [id]: _old, ...rest } = s.undo;
      return { undo: parked ? { ...rest, [id]: { before, after: layoutSig(after), parked } } : rest };
    });
  }
  if (insert) focusContent(id, insert.content);
};

/** The undo grid `id` can offer now: its last layout change parked panes
 *  and nothing has moved since. */
export const undoFor = (s: GridsState, id: string): Undo | null => {
  const u = s.undo[id];
  const g = s.grids[id];
  return u && g && layoutSig(g.panes) === u.after ? u : null;
};

/** Puts grid `id` back as it was before its last layout change. */
export const undoLayout = (id: string): void => {
  const u = undoFor(get(), id);
  dismissUndo(id);
  if (u) changePanes(id, () => u.before);
};

export const dismissUndo = (id: string): void =>
  useGrids.setState((s) => {
    if (!s.undo[id]) return s;
    const { [id]: _gone, ...rest } = s.undo;
    return { undo: rest };
  });

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

/** What a pane held before something else took its place: a terminal
 *  parks (it keeps running, and comes back when there's room); a session
 *  or a conversation just leaves the grid. */
const keepReplaced = (panes: Pane[], old: PaneContent | null | undefined): Pane[] =>
  old?.kind === "terminal" && old.terminalId ? [...panes, { id: paneId(), rect: null, content: old }] : panes;

/** `content` out of the grid if it's there, unless it's in pane `but`. */
const takeOut = (panes: Pane[], content: PaneContent, but: string): Pane[] => {
  const there = findContent(panes, content);
  if (!there || there.id === but) return panes;
  return there.rect ? close(panes, there.id) : panes.filter((p) => p.id !== there.id);
};

/** Drops `content` on pane `target`: a side splits it, the middle replaces
 *  what it holds. Already in the grid, it moves. */
export const dropOnPane = (gridId: string, target: string, zone: Side | "center", content: PaneContent): void => {
  const there = findContent(get().grids[gridId]?.panes ?? [], content);
  if (there?.id === target) return;
  changePanes(gridId, (all) => {
    if (zone === "center") {
      const old = all.find((p) => p.id === target)?.content;
      return keepReplaced(replace(takeOut(all, content, target), target, content), old);
    }
    const done = split(all, target, zone, { id: paneId(), content });
    return done && takeOut(done, content, done.at(-1)!.id);
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

/** Takes pane `pane` out of the grid; what it held is passed on (for the
 *  hub to close a terminal). */
export const closePane = (gridId: string, pane: string, onContent?: (c: PaneContent) => void): void => {
  const p = get().grids[gridId]?.panes.find((x) => x.id === pane);
  if (p?.content && onContent) onContent(p.content);
  changePanes(gridId, (panes) => close(panes, pane));
};

/** Pane `pane` holds `content` instead (see `keepReplaced`). */
export const replacePane = (gridId: string, pane: string, content: PaneContent | null): void => {
  changePanes(gridId, (panes) => {
    const old = panes.find((x) => x.id === pane)?.content;
    const moved = content ? takeOut(panes, content, pane) : panes;
    return keepReplaced(replace(moved, pane, content), old);
  });
  setFocus(gridId, pane);
};

/** Brings a parked pane back into the layout. */
export const unparkPane = (gridId: string, pane: string): boolean => {
  const done = changePanes(gridId, (panes) => unpark(panes, pane));
  if (done) setFocus(gridId, pane);
  return done;
};

/** Moves pane `pane` itself onto pane `target` of the same grid (see
 *  `movePaneTo`): it keeps its id, so what it shows carries on. */
export const movePaneWithin = (gridId: string, pane: string, target: string, zone: Zone): boolean => {
  const done = changePanes(gridId, (panes) => movePaneTo(panes, pane, target, zone, paneId));
  if (done) setFocus(gridId, pane, true);
  return done;
};

/** Swaps parked pane `pane` into the layout (see `swapIn`). */
export const swapInPane = (gridId: string, pane: string): boolean => {
  const done = changePanes(gridId, (panes) => swapIn(panes, pane, askingIn(panes), paneId));
  if (done) setFocus(gridId, pane, true);
  return done;
};

/** The grid and pane showing `content` where it can be seen: a grid in
 *  the main window, or in a window of its own that's open (the grid shown
 *  in the main window first). Parked panes don't count. */
export const showing = (s: GridsState, content: PaneContent): { gridId: string; paneId: string } | null => {
  const ids = [s.active, ...s.order.filter((id) => id !== s.active)];
  for (const id of ids) {
    const g = s.grids[id];
    if (!g || (g.placement.kind === "window" && !s.open[id])) continue;
    const p = findContent(laidOut(g.panes), content);
    if (p) return { gridId: id, paneId: p.id };
  }
  return null;
};

/** Moves pane `paneId`'s content to grid `to` (its pane here closes). */
export const movePane = (from: string, pane: string, to: string): void => {
  const p = get().grids[from]?.panes.find((x) => x.id === pane);
  if (!p?.content || from === to) return;
  const content = p.content;
  changePanes(from, (panes) => close(panes, pane));
  deliver(to, content);
};

/** Moves splitter `s` (as the panes are now) to line `at`, or by `by` steps. */
export const dragSplitter = (gridId: string, s: Splitter, to: { at: number } | { by: number }): void =>
  void changePanes(gridId, (panes) => {
    const live = findSplitter(panes, s);
    if (!live) return null;
    return moveSplitter(panes, live, "at" in to ? to.at : live.at + to.by);
  });

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

