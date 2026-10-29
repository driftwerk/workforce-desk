import { useId, useRef, useState } from "react";
import { countsLine, GridCanvas, GridName, NewTerminalButton, LayoutUndo, PresetPicker, useFillKeys, useGridCounts } from "./GridView";
import { useMainHidden } from "../panels/Stage";
import { Menu, type MenuEntry } from "../ui/Menu";
import { RenameField } from "../ui/RenameField";
import { Confirm } from "../ui/Confirm";
import { SortList, SortRow } from "../groups/rows";
import { useGridDrag } from "./drag";
import { closeGridWindow } from "../platform";
import { createGrid, deleteGrid, moveGrid, nudgeGrid, renameGrid, setActive, setOpen, shownGrid, useGrids } from "./store";
import { closeContent } from "./terminals";
import { bringBack, detach, focusGridWindow, isAway } from "./windows";
import type { Grid } from "./model";

/** The Grids view of the main window: the grid shown here, with its
 *  layouts, a new terminal, and a window of its own. With none shown (there
 *  are none, or each is in a window of its own) it offers a new one, and a
 *  session or agent dropped on it makes one holding it. */
export function GridsMain() {
  const ready = useGrids((s) => s.ready);
  const grid = useGrids(shownGrid);
  const none = useGrids((s) => !s.order.some((id) => s.grids[id]));
  const dragging = useGridDrag((s) => !!s.item && !s.item.from);
  const over = useGridDrag((s) => s.over?.kind === "new");
  const counts = useGridCounts(grid);
  // Behind a focused side panel, the grid doesn't take keys.
  useFillKeys(grid?.id ?? null, !useMainHidden());
  if (!ready) return <main className="grids" aria-label="Grids" />;
  if (!grid) {
    return (
      <main className={`grids grids-none ${over ? "drop-in" : ""}`} aria-label="Grids" data-drop-new-grid="">
        <p className="muted">{dragging ? "Drop it here for a new grid." : none ? "No grids yet" : "Every grid is in a window of its own."}</p>
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

/** The sidebar's list of grids, in the Grids view, drawn as a group's
 *  items are: click one to show it, drag (or Alt+↑/↓) to reorder,
 *  double-click or F2 to rename, right-click, Shift+F10 or its ⋯ for the
 *  rest. A pane dragged onto a row goes to that grid. */
export function GridsSection() {
  const order = useGrids((s) => s.order);
  const grids = useGrids((s) => s.grids);
  const active = useGrids((s) => s.active);
  const open = useGrids((s) => s.open);
  const paneOver = useGridDrag((s) => (s.over?.kind === "row" ? s.over.gridId : null));
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number }; from: HTMLElement | null } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const justDragged = useRef(false);
  const rows = useRef(new Map<string, HTMLElement>());
  const hint = useId();
  const choose = (g: Grid) => {
    if (justDragged.current) return;
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
  /** An empty grid goes at once; one holding anything asks first. */
  const askToRemove = (g: Grid) => (g.panes.some((p) => p.content) ? setDeleting(g.id) : removeGrid(g));
  const sayWhere = (id: string) => {
    const now = useGrids.getState().order;
    setSaid(`${grids[id]?.name}: grid ${now.indexOf(id) + 1} of ${now.length}`);
  };
  const nudge = (id: string, by: -1 | 1) => {
    if (!nudgeGrid(id, by)) return setSaid(by < 0 ? "Already the first grid" : "Already the last grid");
    sayWhere(id);
    requestAnimationFrame(() => rows.current.get(id)?.focus());
  };
  const entries = (g: Grid): MenuEntry[] => [
    { kind: "item", label: "Rename grid", kbd: "F2", onSelect: () => setEditing(g.id) },
    g.placement.kind === "main"
      ? { kind: "item", label: "Open in its own window", onSelect: () => detach(g.id) }
      : { kind: "item", label: "Move back to the main window", onSelect: () => bringBack(g.id) },
    { kind: "separator" },
    { kind: "item", label: "Delete grid…", onSelect: () => askToRemove(g) },
  ];
  const ids = order.filter((id) => grids[id]);
  return (
    <div className="side-section" role="region" aria-label="Grids">
      <span className="side-label side-label-action side-head">
        Grids
        <button type="button" className="icon-btn-sm" aria-label="New grid" title="New grid" onClick={() => createGrid()}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M7 2v10M2 7h10" />
          </svg>
        </button>
      </span>
      <span id={hint} className="sr-only">
        Alt+Up and Alt+Down move it. F2 renames. Shift+F10 opens its menu.
      </span>
      <SortList
        label="Grids"
        type="grid"
        ids={ids}
        chip={(id) => grids[id]?.name}
        onDragStart={() => setMenu(null)}
        justDragged={justDragged}
        onMove={(id, before) => {
          moveGrid(id, before);
          sayWhere(id);
        }}
        empty={<li className="grp-empty faint small">No grids yet</li>}
        row={(id, lineBefore) => {
          const g = grids[id]!;
          return (
            <SortRow
              key={id}
              id={id}
              type="grid"
              lineBefore={lineBefore}
              on={g.placement.kind === "main" && active === id}
              className={paneOver === id ? "drop-in" : ""}
              editing={
                editing === id ? (
                  <RenameField
                    label="Grid name"
                    initial={g.name}
                    mono={false}
                    onDone={(name) => {
                      setEditing(null);
                      if (name !== null) renameGrid(id, name);
                      requestAnimationFrame(() => rows.current.get(id)?.focus());
                    }}
                  />
                ) : null
              }
              name={g.name}
              meta={<span className="gi-meta faint small">{whereIs(g, open)}</span>}
              title="Drag to reorder · double-click to rename"
              describedBy={hint}
              more={`${g.name} options`}
              wrap={{ "data-drop-grid-row": id }}
              register={(el) => (el ? rows.current.set(id, el) : rows.current.delete(id))}
              onOpen={() => choose(g)}
              onStartRename={() => setEditing(id)}
              onNudge={(by) => nudge(id, by)}
              onMenu={(at, from) => setMenu({ id, at, from })}
            />
          );
        }}
      />
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
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
      {deleting && grids[deleting] && (
        <Confirm
          title={`Delete “${grids[deleting]!.name}”?`}
          action="Delete grid"
          onConfirm={() => removeGrid(grids[deleting]!)}
          onClose={() => setDeleting(null)}
        >
          <p className="muted">{deleteNote(grids[deleting]!)}</p>
        </Confirm>
      )}
    </div>
  );
}

/** What deleting a grid does to what's in it. */
export const deleteNote = (g: Grid): string => {
  const terminals = g.panes.filter((p) => p.content?.kind === "terminal").length;
  const others = g.panes.filter((p) => p.content && p.content.kind !== "terminal").length;
  const parts = [];
  if (others) parts.push(`Its ${others === 1 ? "session or agent stays" : `${others} sessions and agents stay`} where ${others === 1 ? "it is" : "they are"}, just off this grid.`);
  if (terminals) parts.push(`${terminals === 1 ? "Its terminal closes" : `Its ${terminals} terminals close`}, with anything running in ${terminals === 1 ? "it" : "them"}.`);
  return parts.join(" ") || "It's empty.";
};
