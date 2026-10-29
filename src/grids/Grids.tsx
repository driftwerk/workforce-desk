import { useState } from "react";
import { countsLine, GridCanvas, GridName, NewTerminalButton, LayoutUndo, PresetPicker, useGridCounts } from "./GridView";
import { Menu, type MenuEntry } from "../ui/Menu";
import { closeGridWindow } from "../platform";
import { createGrid, deleteGrid, setActive, setOpen, useGrids } from "./store";
import { closeContent } from "./terminals";
import { bringBack, detach, focusGridWindow, isAway } from "./windows";
import type { Grid } from "./model";

/** The Grids view of the main window: the grid shown here, with its
 *  layouts, a new terminal, and a window of its own. */
export function GridsMain() {
  const ready = useGrids((s) => s.ready);
  const grid = useGrids((s) => {
    const g = s.grids[s.active];
    return g?.placement.kind === "main" ? g : s.order.map((id) => s.grids[id]).find((x) => x?.placement.kind === "main");
  });
  const counts = useGridCounts(grid);
  if (!ready) return <main className="grids" aria-label="Grids" />;
  if (!grid) {
    return (
      <main className="grids grids-none" aria-label="Grids">
        <p className="muted">Every grid is in a window of its own.</p>
        <button type="button" className="btn btn-signal" onClick={() => createGrid()}>
          New grid
        </button>
      </main>
    );
  }
  return (
    <main className="grids" aria-label={`Grid ${grid.name}`}>
      <header className="grids-head">
        <GridName grid={grid} className="grids-title display" />
        <span className="faint small grids-count">{countsLine(counts)}</span>
        <PresetPicker grid={grid} />
        <span className="grids-fill" />
        <LayoutUndo gridId={grid.id} />
        <NewTerminalButton gridId={grid.id} />
        <button type="button" className="btn btn-ghost gbtn" onClick={() => detach(grid.id)}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <rect x="1.5" y="3.5" width="8" height="8" rx="1.5" />
            <path d="M6 1.5h6.5V8" />
          </svg>
          Open in its own window
        </button>
      </header>
      <GridCanvas key={grid.id} grid={grid} />
    </main>
  );
}

/** Where a grid is, for its row: this window, its monitor, or away. */
const whereIs = (g: Grid, open: Record<string, true>): string =>
  g.placement.kind === "main" ? "this window" : `${g.placement.monitor?.name ?? "its own window"}${isAway(g, open) && g.placement.monitor ? " · away" : ""}`;

/** The sidebar's list of grids, in the Grids view. */
export function GridsSection() {
  const order = useGrids((s) => s.order);
  const grids = useGrids((s) => s.grids);
  const active = useGrids((s) => s.active);
  const open = useGrids((s) => s.open);
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number }; from: HTMLElement | null } | null>(null);
  const choose = (g: Grid) => {
    if (g.placement.kind === "main") setActive(g.id);
    else if (open[g.id]) void focusGridWindow(g.id);
    // Its monitor is away: shown here until it's back (or for good).
    else bringBack(g.id);
  };
  // Its own window closes first, so it can't write the grid back.
  const removeGrid = (g: Grid) => {
    if (open[g.id]) void closeGridWindow(g.id).catch(() => undefined);
    setOpen(g.id, false);
    deleteGrid(g.id, closeContent);
  };
  const entries = (g: Grid): MenuEntry[] => [
    g.placement.kind === "main"
      ? { kind: "item", label: "Open in its own window", onSelect: () => detach(g.id) }
      : { kind: "item", label: "Move back to the main window", onSelect: () => bringBack(g.id) },
    ...(order.length > 1
      ? [
          { kind: "separator" as const },
          { kind: "item" as const, label: "Delete grid", onSelect: () => removeGrid(g) },
        ]
      : []),
  ];
  return (
    <div className="side-section" role="region" aria-label="Grids">
      <span className="side-label">Grids</span>
      {order.map((id) => {
        const g = grids[id];
        if (!g) return null;
        const here = g.placement.kind === "main";
        return (
          <button
            key={id}
            type="button"
            className={`side-row ${here && active === id ? "on" : ""}`}
            aria-current={here && active === id ? "true" : undefined}
            onClick={() => choose(g)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id, at: { x: e.clientX, y: e.clientY }, from: e.currentTarget });
            }}
            onKeyDown={(e) => {
              if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ id, at: { x: r.left + 12, y: r.bottom + 2 }, from: e.currentTarget });
              }
            }}
          >
            <span className="side-name">{g.name}</span>
            <span className="faint small">{whereIs(g, open)}</span>
          </button>
        );
      })}
      <button type="button" className="side-row side-row-add" onClick={() => createGrid()}>
        + New grid
      </button>
      {menu && grids[menu.id] && (
        <Menu
          label={`${grids[menu.id]!.name} options`}
          at={menu.at}
          entries={entries(grids[menu.id]!)}
          onClose={(refocus) => {
            if (refocus) menu.from?.focus();
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}
