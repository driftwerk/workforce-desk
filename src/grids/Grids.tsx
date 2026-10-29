import { Accessibility, defaultPreset, PointerSensor } from "@dnd-kit/dom";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/react";
import { useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { countsLine, GridCanvas, GridName, NewTerminalButton, LayoutUndo, PresetPicker, useGridCounts } from "./GridView";
import { Menu, type MenuEntry } from "../ui/Menu";
import { RenameField } from "../ui/RenameField";
import { Confirm } from "../ui/Confirm";
import { useGridDrag } from "./drag";
import { closeGridWindow } from "../platform";
import { createGrid, deleteGrid, moveGrid, nudgeGrid, renameGrid, setActive, setOpen, useGrids } from "./store";
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

/** Only the pointer drags (Alt+↑/↓ moves from the keyboard), as in the
 *  sidebar's groups. */
const SENSORS = [PointerSensor];
const PLUGINS = defaultPreset.plugins.filter((p) => p !== Accessibility);

type Operation = Parameters<NonNullable<ComponentProps<typeof DragDropProvider>["onDragMove"]>>[0]["operation"];

/** Where a dragged grid would go: before this grid, or last. */
type Drop = { before: string | null };

/** The sidebar's list of grids, in the Grids view: click one to show it,
 *  drag to reorder, double-click or F2 to rename, right-click or Shift+F10
 *  for the rest. A pane dragged onto a row goes to that grid. */
export function GridsSection() {
  const order = useGrids((s) => s.order);
  const grids = useGrids((s) => s.grids);
  const active = useGrids((s) => s.active);
  const open = useGrids((s) => s.open);
  const paneOver = useGridDrag((s) => (s.over?.kind === "row" ? s.over.gridId : null));
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number }; from: HTMLElement | null } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [said, setSaid] = useState("");
  const justDragged = useRef(false);
  const rows = useRef(new Map<string, HTMLElement>());
  const choose = (g: Grid) => {
    if (justDragged.current) return;
    if (g.placement.kind === "main") setActive(g.id);
    else if (open[g.id]) void focusGridWindow(g.id);
    // Its monitor is away: shown here until it's back (or for good).
    else bringBack(g.id);
  };
  // Its own window closes first, so it can't write the grid back.
  // The last grid gives way to a new empty one, so Grids always has one.
  const removeGrid = (g: Grid) => {
    if (open[g.id]) void closeGridWindow(g.id).catch(() => undefined);
    setOpen(g.id, false);
    if (useGrids.getState().order.length <= 1) createGrid();
    deleteGrid(g.id, closeContent);
  };
  /** An empty grid goes at once; one holding anything asks first. */
  const askToRemove = (g: Grid) => (g.panes.some((p) => p.content) ? setDeleting(g.id) : removeGrid(g));
  const nudge = (id: string, by: -1 | 1) => {
    if (!nudgeGrid(id, by)) return setSaid(by < 0 ? "Already the first grid" : "Already the last grid");
    const now = useGrids.getState().order;
    setSaid(`${grids[id]?.name}: grid ${now.indexOf(id) + 1} of ${now.length}`);
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
  const dropFor = (op: Operation): Drop | null => {
    const { source, target } = op;
    if (!source || !target || source.type !== "grid") return null;
    const id = String(target.id);
    const rect = target.element?.getBoundingClientRect();
    const upper = rect ? op.position.current.y < rect.top + rect.height / 2 : true;
    const before = upper ? id : (order[order.indexOf(id) + 1] ?? null);
    return { before };
  };
  const same = (a: Drop | null, b: Drop | null) => a?.before === b?.before && !a === !b;
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
      <DragDropProvider
        sensors={SENSORS}
        plugins={PLUGINS}
        onDragStart={() => setMenu(null)}
        onDragMove={(e) => {
          const d = dropFor(e.operation);
          setDrop((was) => (same(was, d) ? was : d));
        }}
        onDragOver={(e) => {
          const d = dropFor(e.operation);
          setDrop((was) => (same(was, d) ? was : d));
        }}
        onDragEnd={(e) => {
          const s = e.operation.source;
          const d = e.canceled ? null : dropFor(e.operation);
          setDrop(null);
          justDragged.current = true;
          setTimeout(() => (justDragged.current = false), 0);
          if (!s || !d) return;
          const id = String(s.id);
          if (d.before === id || order[order.indexOf(id) + 1] === d.before) return;
          moveGrid(id, d.before);
          const now = useGrids.getState().order;
          setSaid(`${grids[id]?.name}: grid ${now.indexOf(id) + 1} of ${now.length}`);
        }}
      >
        <ul className="side-grids" aria-label="Grids">
          {order.map((id) => {
            const g = grids[id];
            if (!g) return null;
            return (
              <GridRow
                key={id}
                grid={g}
                where={whereIs(g, open)}
                on={g.placement.kind === "main" && active === id}
                lineBefore={drop?.before === id}
                paneOver={paneOver === id}
                editing={editing === id}
                register={(el) => (el ? rows.current.set(id, el) : rows.current.delete(id))}
                onChoose={() => choose(g)}
                onRename={(name) => {
                  setEditing(null);
                  if (name !== null) renameGrid(id, name);
                  requestAnimationFrame(() => rows.current.get(id)?.focus());
                }}
                onStartRename={() => setEditing(id)}
                onNudge={(by) => nudge(id, by)}
                onMenu={(at, from) => setMenu({ id, at, from })}
              />
            );
          })}
          {drop && drop.before === null && <li className="drop-line drop-line-grid" aria-hidden="true" />}
        </ul>
        <DragOverlay dropAnimation={null}>{(source) => <div className="drag-chip">{grids[String(source.id)]?.name}</div>}</DragOverlay>
      </DragDropProvider>
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

export function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="7" r="1.3" />
      <circle cx="7" cy="7" r="1.3" />
      <circle cx="11" cy="7" r="1.3" />
    </svg>
  );
}

const isMenuKey = (e: KeyboardEvent) => e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);

function GridRow({
  grid,
  where,
  on,
  lineBefore,
  paneOver,
  editing,
  register,
  onChoose,
  onRename,
  onStartRename,
  onNudge,
  onMenu,
}: {
  grid: Grid;
  where: string;
  on: boolean;
  lineBefore: boolean;
  paneOver: boolean;
  editing: boolean;
  register: (el: HTMLElement | null) => void;
  onChoose: () => void;
  onRename: (name: string | null) => void;
  onStartRename: () => void;
  onNudge: (by: -1 | 1) => void;
  onMenu: (at: { x: number; y: number }, from: HTMLElement | null) => void;
}) {
  const row = useRef<HTMLButtonElement | null>(null);
  const drag = useDraggable({ id: grid.id, type: "grid", element: row, disabled: editing });
  useDroppable({ id: grid.id, type: "grid", accept: "grid", element: row });
  return (
    <>
      {lineBefore && <li className="drop-line drop-line-grid" aria-hidden="true" />}
      <li className={`side-grid side-item ${drag.isDragSource ? "ghost" : ""}`} data-drop-grid-row={grid.id}>
        {editing ? (
          <span className="side-row side-row-editing">
            <RenameField label="Grid name" initial={grid.name} mono={false} onDone={onRename} />
          </span>
        ) : (
          <button
            ref={(el) => {
              row.current = el;
              register(el);
            }}
            type="button"
            className={`side-row ${on ? "on" : ""} ${paneOver ? "drop-in" : ""}`}
            aria-current={on ? "true" : undefined}
            title="Drag to reorder · double-click to rename"
            onClick={onChoose}
            onDoubleClick={(e) => {
              e.preventDefault();
              onStartRename();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu({ x: e.clientX, y: e.clientY }, e.currentTarget);
            }}
            onKeyDown={(e) => {
              const by = e.altKey && !e.metaKey && !e.ctrlKey ? (e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0) : 0;
              if (by) {
                e.preventDefault();
                onNudge(by);
              } else if (e.key === "F2") {
                e.preventDefault();
                onStartRename();
              } else if (isMenuKey(e)) {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                onMenu({ x: r.left + 12, y: r.bottom + 2 }, e.currentTarget);
              }
            }}
          >
            <span className="side-name">{grid.name}</span>
            <span className="faint small">{where}</span>
          </button>
        )}
        {!editing && (
          <button
            type="button"
            className="icon-btn-sm side-more"
            aria-label={`${grid.name} options`}
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onMenu({ x: r.left, y: r.bottom + 2 }, e.currentTarget);
            }}
          >
            <MoreIcon />
          </button>
        )}
      </li>
    </>
  );
}
