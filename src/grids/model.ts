// A grid as kept: its panes, and where it's shown — in Desk's main window,
// or in a window of its own on a monitor. Kept under `grid.index` (the
// order) and `grid.<id>` (each grid).

import { blank, type Pane } from "./engine";

/** "Fills the screen" (its work area), "Free size", or "Full screen (own Space)". */
export type WindowMode = "fill" | "free" | "fullscreen";

export const WINDOW_MODES: { id: WindowMode; label: string }[] = [
  { id: "fill", label: "Fills the screen" },
  { id: "free", label: "Free size" },
  { id: "fullscreen", label: "Full screen (own Space)" },
];

/** A monitor as Desk recognises it again: `name:WxH@scale` (its physical
 *  size and scale, as Desk's window frames key it), with its work area's
 *  origin to tell identical ones apart. */
export interface MonitorRef {
  id: string;
  name: string;
  origin: [number, number];
}

export type Placement =
  | { kind: "main" }
  /** In a window of its own. Its frame is kept by Desk's native side, per
   *  monitor arrangement, under `window.grid-<id>.<arrangement>`, as the
   *  main window's is. */
  | { kind: "window"; mode: WindowMode; monitor: MonitorRef | null };

export interface Grid {
  id: string;
  name: string;
  panes: Pane[];
  placement: Placement;
}

export const MAIN_GRID = "main";
export const INDEX_KEY = "grid.index";
export const gridKey = (id: string): string => `grid.${id}`;

export const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** A short id for panes. */
export const paneId = (): string => newId().slice(0, 8);

export const mainGrid = (): Grid => ({ id: MAIN_GRID, name: "Main", panes: blank(paneId), placement: { kind: "main" } });

export const windowLabel = (gridId: string): string => `grid-${gridId}`;
export const gridOfLabel = (label: string): string | null => (label.startsWith("grid-") ? label.slice(5) : null);

/** A grid read back, or null when it isn't one (an older or broken value). */
export const readGrid = (v: unknown): Grid | null => {
  if (!v || typeof v !== "object") return null;
  const g = v as Partial<Grid>;
  if (typeof g.id !== "string" || typeof g.name !== "string" || !Array.isArray(g.panes)) return null;
  const placement: Placement =
    g.placement && typeof g.placement === "object" && g.placement.kind === "window"
      ? {
          kind: "window",
          mode: (["fill", "free", "fullscreen"] as const).includes(g.placement.mode) ? g.placement.mode : "fill",
          monitor: g.placement.monitor ?? null,
        }
      : { kind: "main" };
  const panes = g.panes.filter((p): p is Pane => !!p && typeof p === "object" && typeof (p as Pane).id === "string");
  return { id: g.id, name: g.name, panes: panes.length ? panes : blank(paneId), placement };
};

export const readIndex = (v: unknown): string[] | null => {
  const order = (v as { order?: unknown } | null)?.order;
  return Array.isArray(order) ? order.filter((x): x is string => typeof x === "string") : null;
};

/** "Grid 2", "Grid 3", … — the first free one. */
export const nextName = (grids: Grid[]): string => {
  const taken = new Set(grids.map((g) => g.name));
  for (let n = 2; ; n++) if (!taken.has(`Grid ${n}`)) return `Grid ${n}`;
};
