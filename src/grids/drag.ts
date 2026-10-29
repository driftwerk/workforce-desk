// A session or agent dragged from the sidebar onto a grid. The sidebar's
// drag and drop (dnd-kit, in groups/SidebarGroups) carries it; while it's
// over the grid, this says where — which pane and which part of it, or
// which place in a layout of the floating strip — so the grid can show the
// zones and take the drop.

import { create } from "zustand";
import { zoneAt, type PaneContent, type PresetId, type Zone } from "./engine";
import { deliver, dropOnPane, layOut } from "./store";

export type GridTarget =
  | { kind: "pane"; gridId: string; paneId: string; zone: Zone }
  | { kind: "preset"; gridId: string; preset: PresetId; slot: number }
  /** ⇧ held: anywhere on the grid, into the next free place. */
  | { kind: "free"; gridId: string };

interface GridDrag {
  /** What's being dragged, while it is. */
  item: { content: PaneContent; name: string } | null;
  over: GridTarget | null;
  /** ⇧ is held: drop without snapping. */
  free: boolean;
}

export const useGridDrag = create<GridDrag>(() => ({ item: null, over: null, free: false }));

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
export const targetAt = (x: number, y: number, free: boolean): GridTarget | null => {
  const els = typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(x, y) : [];
  for (const el of els) {
    if (!(el instanceof HTMLElement)) continue;
    const slot = el.closest<HTMLElement>("[data-drop-preset]");
    if (slot) {
      return { kind: "preset", gridId: slot.dataset.grid!, preset: slot.dataset.dropPreset as PresetId, slot: Number(slot.dataset.slot ?? 0) };
    }
    const pane = el.closest<HTMLElement>("[data-drop-pane]");
    if (pane) {
      const gridId = pane.dataset.grid!;
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
  const over = targetAt(x, y, s.free);
  if (!sameTarget(over, s.over)) useGridDrag.setState({ over });
  return over !== null;
};

/** The drag ended: where it landed on a grid (none when it was cancelled or
 *  wasn't over one), with what was dragged. */
export const endGridDrag = (canceled: boolean): { target: GridTarget; content: PaneContent } | null => {
  const { item, over } = useGridDrag.getState();
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("keyup", onKey);
  useGridDrag.setState({ item: null, over: null, free: false });
  last = null;
  return !canceled && item && over ? { target: over, content: item.content } : null;
};

/** Puts what was dropped where it landed. */
export const dropOnGrid = (target: GridTarget, content: PaneContent): void => {
  if (target.kind === "pane") dropOnPane(target.gridId, target.paneId, target.zone, content);
  else if (target.kind === "preset") layOut(target.gridId, target.preset, { slot: target.slot, content });
  else deliver(target.gridId, content);
};
