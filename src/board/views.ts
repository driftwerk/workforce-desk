// How each board was last shown: its order, its quick filter (Everyone,
// Mine …) and a synced board's own filters (epic, type, sprint …). Kept
// under `ui.boardViews` in Desk's restore store, so switching boards or
// restarting Desk shows each as the person left it. What's saved is read
// warily: a value that isn't one Desk knows is left out, and the board's
// default shown.

import { create } from "zustand";
import type { Restorable } from "../restore/boot";
import { FILTERS, type BoardFilter, type BoardOrder } from "./board";
import type { FacetId, Facets } from "./facets";

export const BOARD_VIEWS_KEY = "ui.boardViews";

/** One board's view; what isn't said is its default. */
export interface BoardView {
  order?: BoardOrder;
  filter?: BoardFilter;
  facets?: Facets;
}

export const useBoardViews = create<{ views: Record<string, BoardView> }>(() => ({ views: {} }));

const ORDERS: readonly BoardOrder[] = ["source", "newest", "oldest", "changed", "arranged"];
const FACET_IDS: readonly FacetId[] = ["epic", "type", "sprint", "project", "label"];

const isOrder = (v: unknown): v is BoardOrder => typeof v === "string" && (ORDERS as readonly string[]).includes(v);
const isFilter = (v: unknown): v is BoardFilter => typeof v === "string" && FILTERS.some((f) => f.id === v);

const readFacets = (v: unknown): Facets | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Facets = {};
  for (const id of FACET_IDS) {
    const want = (v as Record<string, unknown>)[id];
    if (typeof want === "string" && want) out[id] = want;
  }
  return Object.keys(out).length ? out : undefined;
};

const readView = (v: unknown): BoardView | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const view: BoardView = {};
  if (isOrder(o.order)) view.order = o.order;
  if (isFilter(o.filter)) view.filter = o.filter;
  const facets = readFacets(o.facets);
  if (facets) view.facets = facets;
  return Object.keys(view).length ? view : null;
};

/** The views saved, each board's read on its own: anything garbled is
 *  dropped, the rest kept. */
export const readViews = (v: unknown): Record<string, BoardView> => {
  const views = (v as { views?: unknown } | null)?.views;
  if (!views || typeof views !== "object" || Array.isArray(views)) return {};
  const out: Record<string, BoardView> = {};
  for (const [board, raw] of Object.entries(views)) {
    const view = readView(raw);
    if (view) out[board] = view;
  }
  return out;
};

/** Board `id`'s view, as kept. */
export const useBoardView = (id: string | null | undefined): BoardView => useBoardViews((s) => (id ? s.views[id] : undefined) ?? NONE);
const NONE: BoardView = {};

/** Changes part of board `id`'s view, keeping the rest. */
export const setBoardView = (id: string, change: Partial<BoardView>): void =>
  useBoardViews.setState((s) => ({ views: { ...s.views, [id]: { ...s.views[id], ...change } } }));

export const boardViews: Restorable = {
  key: BOARD_VIEWS_KEY,
  read: () => ({ views: useBoardViews.getState().views }),
  write: (v) => useBoardViews.setState({ views: readViews(v) }),
  subscribe: (onChange) => useBoardViews.subscribe(onChange),
};
