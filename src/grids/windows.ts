// Grids across Desk's windows: starting the grid store in a window, telling
// the other windows what changed, passing panes to the window that writes a
// grid, and — in the main window — keeping each detached grid's window open
// on its monitor (closed while that monitor is away, reopened when it's
// back).

import { emit, emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import {
  closeGridWindow,
  gridWindowsOpen,
  inApp,
  listen,
  monitorsNow,
  openGridWindow,
  subscribe as listenerCleanup,
  type MonitorInfo,
} from "../platform";
import { deskState } from "../restore/boot";
import type { PaneContent } from "./engine";
import { gridOfLabel, MAIN_GRID, windowLabel, type Grid, type MonitorRef, type WindowMode } from "./model";
import { GRID_PREFIX } from "./storage";
import { deliver, heardGrid, setActive, setOpen, setPlacement, startGrids, useGrids, type Role } from "./store";

/** This window's label: `main`, or `grid-<id>` for a detached grid. */
export const thisWindow = (): string => (inApp ? getCurrentWindow().label : "main");

/** The grid this window is for, when it's a detached grid's. */
export const detachedGrid = (): string | null => gridOfLabel(thisWindow());

/** How long the main window waits for the hub before making a first grid,
 *  so a Mac with an empty file takes the grids the hub already has. */
const FIRST_GRID_WAIT_MS = 3000;

const hubAnswered = async (ms: number) => {
  const until = Date.now() + ms;
  while (deskState.hubHas === "unknown" && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
};

/** Starts grids in this window. */
export async function startGridsHere(role: Role): Promise<() => void> {
  const label = role.kind === "main" ? "main" : windowLabel(role.gridId);
  if (!deskState.get("grid.index")) await hubAnswered(FIRST_GRID_WAIT_MS);
  startGrids(deskState, role, {
    deliver: (gridId, content) =>
      void emitTo(role.kind === "main" ? windowLabel(gridId) : "main", "grid-deliver", { gridId, content }).catch(() => undefined),
  });
  if (!inApp) return () => {};
  const stops = [
    // Other windows hear this one's changes at once (the hub tells them
    // too, but only once it has a state store and has stored them).
    deskState.subscribe(GRID_PREFIX, (key, value, origin) => {
      if (origin === "local") void emit("grid-state", { key, value, from: label }).catch(() => undefined);
    }),
    listenerCleanup(
      listen<{ key: string; value: unknown; from: string }>("grid-state", (e) => {
        if (e.payload.from !== label) heardGrid(e.payload.key, e.payload.value);
      }),
    ),
    // A pane sent here: placed if this window writes its grid, else passed on.
    listenerCleanup(listen<{ gridId: string; content: PaneContent }>("grid-deliver", (e) => deliver(e.payload.gridId, e.payload.content))),
  ];
  return () => stops.forEach((s) => s());
}

const sameMonitor = (a: MonitorRef | null, b: MonitorInfo) => !!a && a.id === b.id && a.origin[0] === b.origin[0] && a.origin[1] === b.origin[1];

/** How often the main window looks at the monitors. */
const RECONCILE_MS = 2000;

/** The main window keeps every detached grid's window open on its monitor,
 *  and closes it while the monitor is away or once the grid is back in the
 *  main window. */
export function useGridWindows(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !inApp) return;
    let busy = false;
    let again = false;
    const tick = async () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const [monitors, open] = await Promise.all([monitorsNow(), gridWindowsOpen()]);
        const s = useGrids.getState();
        for (const id of Object.keys(s.open)) if (!open.includes(id)) setOpen(id, false);
        for (const id of s.order) {
          const g = s.grids[id];
          if (!g) continue;
          const isOpen = open.includes(id);
          if (g.placement.kind === "main") {
            if (isOpen) await closeGridWindow(id);
            setOpen(id, false);
            continue;
          }
          const p = g.placement;
          const here = !p.monitor || monitors.some((m) => m.id === p.monitor!.id);
          if (!here) {
            // Away: closed until it's back. The grid keeps writing in the
            // main window meanwhile.
            if (isOpen) await closeGridWindow(id);
            setOpen(id, false);
            continue;
          }
          if (isOpen) {
            setOpen(id, true);
            continue;
          }
          const m = await openGridWindow(id, g.name, p.mode, p.monitor && { id: p.monitor.id, origin: p.monitor.origin });
          if (!m) continue;
          // Recorded while the main window still writes the grid.
          if (!sameMonitor(p.monitor, m)) setPlacement(id, { ...p, monitor: { id: m.id, name: m.name, origin: m.origin } });
          setOpen(id, true);
        }
      } catch (e) {
        console.warn("couldn't arrange grid windows:", e);
      } finally {
        busy = false;
        if (again) {
          again = false;
          void tick();
        }
      }
    };
    void tick();
    const t = setInterval(() => void tick(), RECONCILE_MS);
    const stop = useGrids.subscribe((s, before) => {
      if (s.grids !== before.grids) void tick();
    });
    return () => {
      clearInterval(t);
      stop();
    };
  }, [enabled]);
}

/** Gives grid `id` a window of its own (on a monitor the main window isn't
 *  on, where there is one); the main window shows another grid. */
export const detach = (id: string, mode: WindowMode = "fill"): void => {
  setPlacement(id, { kind: "window", mode, monitor: null });
  const s = useGrids.getState();
  if (s.active === id) setActive(s.order.find((x) => x !== id && s.grids[x]?.placement.kind === "main") ?? MAIN_GRID);
};

/** Shows grid `id` in the main window again. Its own window, while it has
 *  one, writes it: that window is asked to give it back (as its close
 *  button does). */
export const bringBack = (id: string): void => {
  if (useGrids.getState().open[id]) void emitTo(windowLabel(id), "grid-close", null).catch(() => undefined);
  else setPlacement(id, { kind: "main" });
  setActive(id);
};

/** A detached grid whose window isn't open: its monitor is away (or it's
 *  being opened). */
export const isAway = (g: Grid, open: Record<string, true>): boolean => g.placement.kind === "window" && !open[g.id];

/** Brings a detached grid's open window forward. */
export const focusGridWindow = async (id: string): Promise<void> => {
  const g = useGrids.getState().grids[id];
  if (g?.placement.kind !== "window") return;
  await openGridWindow(id, g.name, g.placement.mode, g.placement.monitor && { id: g.placement.monitor.id, origin: g.placement.monitor.origin }).catch(
    (e: unknown) => console.warn(`couldn't bring ${g.name} forward:`, e),
  );
};
