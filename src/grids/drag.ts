// Dragging onto a grid. A session or agent comes from the sidebar, whose
// drag and drop (dnd-kit, in groups/SidebarGroups) carries it; a pane is
// dragged by its header (or a parked one from the tray), with the pointer
// followed here. While either is over a grid, this says where — which pane
// and which part of it, which place in a layout of the floating strip, or
// which grid's row in the sidebar — so the grid can show the zones and take
// the drop.

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";
import { close, zoneAt, type Pane, type PaneContent, type PresetId, type Zone } from "./engine";
import { changePanes, createGrid, deliver, dropOnPane, layOut, movePane, movePaneWithin, useGrids } from "./store";

export type GridTarget =
  | { kind: "pane"; gridId: string; paneId: string; zone: Zone }
  | { kind: "preset"; gridId: string; preset: PresetId; slot: number }
  /** ⇧ held: anywhere on the grid, into the next free place. */
  | { kind: "free"; gridId: string }
  /** A grid's row in the sidebar: its next free place. */
  | { kind: "row"; gridId: string }
  /** The Grids view showing no grid: a new grid, holding it. */
  | { kind: "new" };

/** A pane being dragged, from where it is. */
export interface FromPane {
  gridId: string;
  paneId: string;
  /** Dragged from the parked tray: it swaps with the pane it's dropped on. */
  parked?: boolean;
}

interface GridDrag {
  /** What's being dragged, while it is; `from` when it's a pane. */
  item: { content: PaneContent; name: string; from?: FromPane } | null;
  over: GridTarget | null;
  /** ⇧ is held: drop without snapping. */
  free: boolean;
  /** Where the pointer is, while a pane is dragged (its chip follows). */
  at: { x: number; y: number } | null;
}

export const useGridDrag = create<GridDrag>(() => ({ item: null, over: null, free: false, at: null }));

const sameTarget = (a: GridTarget | null, b: GridTarget | null) => JSON.stringify(a) === JSON.stringify(b);

/** A sidebar item's key (`session:<id>`, `agent:<hub>/<agent>`) as what a
 *  pane holds. */
export const contentOfItem = (key: string): PaneContent | null =>
  key.startsWith("session:")
    ? { kind: "session", sessionId: key.slice("session:".length) }
    : key.startsWith("agent:")
      ? { kind: "agent", agent: key.slice("agent:".length) }
      : null;

/** Where the pointer was last, so pressing or letting go of ⇧ without
 *  moving shows the change at once. */
let last: { x: number; y: number } | null = null;

const onKey = (e: KeyboardEvent) => {
  if (e.key !== "Shift") return;
  useGridDrag.setState({ free: e.type === "keydown" });
  if (last) moveGridDrag(last.x, last.y);
};

export const startGridDrag = (content: PaneContent, name: string): void => {
  useGridDrag.setState({ item: { content, name }, over: null, free: false });
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
};

/** What's under the point: the floating layouts first, then a pane's body
 *  (its header too). The dragged chip itself is skipped, being under the
 *  pointer always. */
export const targetAt = (x: number, y: number, free: boolean, from?: FromPane): GridTarget | null => {
  const els = typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(x, y) : [];
  for (const el of els) {
    if (!(el instanceof HTMLElement)) continue;
    const row = el.closest<HTMLElement>("[data-drop-grid-row]");
    if (row) return { kind: "row", gridId: row.dataset.dropGridRow! };
    if (!from && el.closest("[data-drop-new-grid]")) return { kind: "new" };
    const slot = from ? null : el.closest<HTMLElement>("[data-drop-preset]");
    if (slot) {
      return { kind: "preset", gridId: slot.dataset.grid!, preset: slot.dataset.dropPreset as PresetId, slot: Number(slot.dataset.slot ?? 0) };
    }
    const pane = el.closest<HTMLElement>("[data-drop-pane]");
    if (pane) {
      const gridId = pane.dataset.grid!;
      // A pane over itself goes nowhere.
      if (from && from.gridId === gridId && from.paneId === pane.dataset.dropPane) return null;
      if (free) return { kind: "free", gridId };
      const r = pane.getBoundingClientRect();
      return { kind: "pane", gridId, paneId: pane.dataset.dropPane!, zone: zoneAt(r, x, y) };
    }
    const grid = el.closest<HTMLElement>("[data-drop-grid]");
    if (grid && free) return { kind: "free", gridId: grid.dataset.dropGrid! };
  }
  return null;
};

/** The pointer moved; true while it's over a grid (the sidebar then shows
 *  no drop of its own). */
export const moveGridDrag = (x: number, y: number): boolean => {
  const s = useGridDrag.getState();
  if (!s.item) return false;
  last = { x, y };
  const over = targetAt(x, y, s.free, s.item.from);
  if (!sameTarget(over, s.over)) useGridDrag.setState({ over });
  if (s.item.from) useGridDrag.setState({ at: { x, y } });
  return over !== null;
};

/** The drag ended: where it landed on a grid (none when it was cancelled or
 *  wasn't over one), with what was dragged. */
export const endGridDrag = (canceled: boolean): { target: GridTarget; content: PaneContent } | null => {
  const { item, over } = useGridDrag.getState();
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("keyup", onKey);
  useGridDrag.setState({ item: null, over: null, free: false, at: null });
  last = null;
  return !canceled && item && over ? { target: over, content: item.content } : null;
};

/** Puts what was dropped where it landed. */
export const dropOnGrid = (target: GridTarget, content: PaneContent): void => {
  if (target.kind === "new") deliver(createGrid(), content);
  else if (target.kind === "pane") dropOnPane(target.gridId, target.paneId, target.zone, content);
  else if (target.kind === "preset") layOut(target.gridId, target.preset, { slot: target.slot, content });
  else deliver(target.gridId, content);
};

// ── Dragging a pane ────────────────────────────────────────────────────────

/** How far the pointer goes before a press on a header becomes a drag. */
const DRAG_PX = 4;

let dragged = false;

/** Whether a pane drag just ended (the click that follows isn't a click). */
export const paneJustDragged = (): boolean => dragged;

const onEscape = (e: KeyboardEvent) => {
  if (e.key !== "Escape" || !useGridDrag.getState().item?.from) return;
  e.preventDefault();
  e.stopPropagation();
  endPaneDrag(true);
};

export const startPaneDrag = (from: FromPane, content: PaneContent, name: string, x: number, y: number): void => {
  useGridDrag.setState({ item: { content, name, from }, over: null, free: false, at: { x, y } });
  document.body.classList.add("gpane-moving");
  window.addEventListener("keydown", onEscape, true);
};

/** The pane drag ended: dropped where it was over (a pane of its own grid
 *  moves itself, keeping what it shows; another grid takes it in its next
 *  free place), or nowhere when it was cancelled. */
export const endPaneDrag = (canceled: boolean): void => {
  const { item, over } = useGridDrag.getState();
  useGridDrag.setState({ item: null, over: null, free: false, at: null });
  document.body.classList.remove("gpane-moving");
  window.removeEventListener("keydown", onEscape, true);
  last = null;
  dragged = true;
  setTimeout(() => (dragged = false), 0);
  const from = item?.from;
  if (canceled || !from || !over) return;
  dropPane(from, over);
};

/** Puts pane `from` where it was dropped. */
export const dropPane = (from: FromPane, over: GridTarget): void => {
  const p = useGrids.getState().grids[from.gridId]?.panes.find((x) => x.id === from.paneId);
  // A pane is in a grid already, so there's one to show (see `targetAt`).
  if (!p?.content || over.kind === "new") return;
  if (over.gridId === from.gridId) {
    // A parked pane swaps in, whatever part of the pane it's dropped on.
    if (over.kind === "pane") movePaneWithin(from.gridId, from.paneId, over.paneId, p.rect ? over.zone : "center");
    return;
  }
  if (over.kind === "pane") {
    const content = p.content;
    changePanes(from.gridId, (panes) => close(panes, from.paneId));
    dropOnPane(over.gridId, over.paneId, over.zone, content);
  } else movePane(from.gridId, from.paneId, over.gridId);
};

/** A pane's handle (its header, or its chip in the parked tray): pressed
 *  and moved, the pane is dragged. Presses on its buttons are left alone. */
export function usePaneDrag(gridId: string, pane: Pane, name: string): { onPointerDown: (e: ReactPointerEvent) => void } {
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || !pane.content) return;
    const t = e.target as Element;
    if (t.closest("button:not([data-drag-handle]), input, select, a")) return;
    const content = pane.content;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moving = false;
    const move = (ev: PointerEvent) => {
      if (!moving) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_PX) return;
        moving = true;
        startPaneDrag({ gridId, paneId: pane.id, parked: !pane.rect }, content, name, ev.clientX, ev.clientY);
      }
      moveGridDrag(ev.clientX, ev.clientY);
    };
    const up = (ev: PointerEvent) => {
      done();
      if (moving && useGridDrag.getState().item?.from) {
        moveGridDrag(ev.clientX, ev.clientY);
        endPaneDrag(ev.type === "pointercancel");
      }
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      stop.current = null;
    };
    stop.current?.();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    stop.current = () => {
      done();
      if (moving && useGridDrag.getState().item?.from?.paneId === pane.id) endPaneDrag(true);
    };
  };
  return { onPointerDown };
}
