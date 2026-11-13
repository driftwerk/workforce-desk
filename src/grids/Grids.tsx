import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useBoard } from "../board/store";
import { TicketPopup } from "../board/TicketDetail";
import { countsLine, GridCanvas, GridName, NewTerminalButton, LayoutUndo, PresetPicker, useFillKeys, useGridCounts } from "./GridView";
import { useMainHidden } from "../panels/Stage";
import { Menu, type MenuEntry } from "../ui/Menu";
import { RenameField } from "../ui/RenameField";
import { Confirm } from "../ui/Confirm";
import { SortList, SortRow } from "../groups/rows";
import { useGridDrag } from "./drag";
import { closeGridWindow } from "../platform";
import { createGrid, deleteGrid, hostedBy, moveGrid, nudgeGrid, renameGrid, setActive, setOpen, shownGrid, useGrids } from "./store";
import { closeContent } from "./terminals";
import { terminalContent } from "./engine";
import { bringBack, detach, focusGridWindow, isAway } from "./windows";
import type { Grid } from "./model";
import { GridsMarks, useGridsBadge } from "../unread/GridMarks";
import { Marks } from "../unread/Marks";
import { needsYou } from "../ui/Badge";
import { useDesk } from "../hub/store";
import { setSectionOpen, SideSection } from "../shell/SideSection";

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
  // A ticket open over the grid goes with it, and when another grid shows.
  const gridId = grid?.id;
  useEffect(() => () => useBoard.getState().openPopup(null), [gridId]);
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
      <TicketPopup />
    </main>
  );
}

/** Where a grid in a window of its own is, for its row: its monitor, or
 *  away; none for one shown here. */
const whereIs = (g: Grid, open: Record<string, true>): string | null =>
  g.placement.kind === "main" ? null : `${g.placement.monitor?.name ?? "its own window"}${isAway(g, open) && g.placement.monitor ? " · away" : ""}`;

/** What a grid row says of its panes: what waits on you there, else how
 *  many work, else that it's quiet. */
export const gridState = (needs: number, working: number): { look: "blocked" | "working" | "idle"; says: string } =>
  needs > 0 ? { look: "blocked", says: needsYou(needs) } : working > 0 ? { look: "working", says: `${working} working` } : { look: "idle", says: "quiet" };

type RowProps = {
  id: string;
  lineBefore: boolean;
  editing: boolean;
  hint: string;
  register: (id: string, el: HTMLElement | null) => void;
  onOpen: (g: Grid) => void;
  onRenamed: (id: string, name: string | null) => void;
  onStartRename: (id: string) => void;
  onNudge: (id: string, by: -1 | 1) => void;
  onMenu: (id: string, at: { x: number; y: number }, from: HTMLElement | null) => void;
};

/** One grid's row: it reads its own grid and what its panes are doing, so
 *  a session changing in one grid draws only that grid's row again. */
const GridRow = memo(function GridRow({ id, lineBefore, editing, hint, register, onOpen, onRenamed, onStartRename, onNudge, onMenu }: RowProps) {
  const g = useGrids((s) => s.grids[id]);
  const active = useGrids((s) => s.active === id);
  const inGrids = useDesk((s) => s.view === "grids");
  const on = active && inGrids && g?.placement.kind === "main";
  const where = useGrids((s) => (s.grids[id] ? whereIs(s.grids[id]!, s.open) : null));
  const paneOver = useGridDrag((s) => s.over?.kind === "row" && s.over.gridId === id);
  const counts = useGridCounts(g);
  const badge = useGridsBadge(g ? [g] : []);
  if (!g) return null;
  // What's for you there (an agent asking, a mention) and the sessions
  // stopped on you, as the grid's own header counts them.
  const state = gridState(Math.max(badge.count, counts.needsYou), counts.working);
  return (
    <SortRow
      id={id}
      type="grid"
      lineBefore={lineBefore}
      on={on}
      className={paneOver ? "drop-in" : ""}
      editing={
        editing ? <RenameField label="Grid name" initial={g.name} mono={false} onDone={(name) => onRenamed(id, name)} /> : null
      }
      lead={<span className={`dot dot-${state.look} dot-state`} aria-hidden="true" />}
      name={g.name}
      meta={
        <span className={`gi-meta small ${state.look === "blocked" ? "state-blocked" : "faint"}`}>
          {where ? `${state.says} · ${where}` : state.says}
        </span>
      }
      title="Drag to reorder · double-click to rename"
      describedBy={hint}
      more={`${g.name} options`}
      wrap={{ "data-drop-grid-row": id }}
      register={(el) => register(id, el)}
      onOpen={() => onOpen(g)}
      onStartRename={() => onStartRename(id)}
      onNudge={(by) => onNudge(id, by)}
      onMenu={(at, from) => onMenu(id, at, from)}
    >
      {badge.dot && <Marks badge={{ count: 0, dot: true }} />}
    </SortRow>
  );
});

/** The sidebar's Grids: a section as Rooms is, each grid's row saying
 *  what its panes are doing. Click one to show it, drag (or Alt+↑/↓) to
 *  reorder, double-click or F2 to rename, right-click, Shift+F10 or its ⋯
 *  for the rest. A pane dragged onto a row goes to that grid. */
export function GridsSection() {
  const ids = useGrids(useShallow((s) => s.order.filter((id) => s.grids[id])));
  const active = useGrids((s) => s.active);
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number }; from: HTMLElement | null } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const justDragged = useRef(false);
  const rows = useRef(new Map<string, HTMLElement>());
  const hint = useId();
  // A grid shown from elsewhere (a pane revealed, a new terminal) opens
  // Grids, so its row shows; once each time, so it can be closed again.
  const shownBefore = useRef(active);
  const shown = useDesk((s) => s.view === "grids");
  useEffect(() => {
    if (!shown || active === shownBefore.current) return;
    shownBefore.current = active;
    if (active) setSectionOpen("grids", true);
  }, [active, shown]);
  const grid = (id: string) => useGrids.getState().grids[id];
  const choose = useCallback((g: Grid) => {
    if (justDragged.current) return;
    const s = useGrids.getState();
    if (g.placement.kind === "window" && s.open[g.id]) return void focusGridWindow(g.id);
    // Its monitor is away: shown here until it's back (or for good).
    if (g.placement.kind !== "main") bringBack(g.id);
    else setActive(g.id);
    shownBefore.current = g.id;
    useDesk.getState().setView("grids");
  }, []);
  // Its own window closes first, so it can't write the grid back. The
  // terminals only its sessions' panes keep open close with it.
  const removeGrid = (g: Grid) => {
    if (useGrids.getState().open[g.id]) void closeGridWindow(g.id).catch(() => undefined);
    setOpen(g.id, false);
    const hosted = hostedIn(g);
    deleteGrid(g.id, closeContent);
    for (const key of hosted) closeContent(terminalContent(key));
  };
  /** An empty grid goes at once; one holding anything asks first. */
  const askToRemove = (g: Grid) => (g.panes.some((p) => p.content) ? setDeleting(g.id) : removeGrid(g));
  const sayWhere = (id: string) => {
    const now = useGrids.getState().order;
    setSaid(`${grid(id)?.name}: grid ${now.indexOf(id) + 1} of ${now.length}`);
  };
  const nudge = useCallback((id: string, by: -1 | 1) => {
    if (!nudgeGrid(id, by)) return setSaid(by < 0 ? "Already the first grid" : "Already the last grid");
    sayWhere(id);
    requestAnimationFrame(() => rows.current.get(id)?.focus());
  }, []);
  const register = useCallback((id: string, el: HTMLElement | null) => (el ? rows.current.set(id, el) : rows.current.delete(id)), []);
  const renamed = useCallback((id: string, name: string | null) => {
    setEditing(null);
    if (name !== null) renameGrid(id, name);
    requestAnimationFrame(() => rows.current.get(id)?.focus());
  }, []);
  const openMenu = useCallback((id: string, at: { x: number; y: number }, from: HTMLElement | null) => setMenu({ id, at, from }), []);
  const entries = (g: Grid): MenuEntry[] => [
    { kind: "item", label: "Rename grid", kbd: "F2", onSelect: () => setEditing(g.id) },
    g.placement.kind === "main"
      ? { kind: "item", label: "Open in its own window", onSelect: () => detach(g.id) }
      : {
          kind: "item",
          label: "Move back to the main window",
          onSelect: () => {
            bringBack(g.id);
            useDesk.getState().setView("grids");
          },
        },
    { kind: "separator" },
    { kind: "item", label: "Delete grid…", onSelect: () => askToRemove(g) },
  ];
  const menuGrid = menu ? grid(menu.id) : undefined;
  const deletingGrid = deleting ? grid(deleting) : undefined;
  return (
    <SideSection
      id="grids"
      label="Grids"
      newLabel="New grid"
      onNew={() => {
        createGrid();
        useDesk.getState().setView("grids");
      }}
      marks={<GridsMarks />}
    >
      <span id={hint} className="sr-only">
        Alt+Up and Alt+Down move it. F2 renames. Shift+F10 opens its menu.
      </span>
      <SortList
        label="Grids"
        type="grid"
        ids={ids}
        chip={(id) => grid(id)?.name}
        onDragStart={() => setMenu(null)}
        justDragged={justDragged}
        onMove={(id, before) => {
          moveGrid(id, before);
          sayWhere(id);
        }}
        empty={<li className="grp-empty faint small">No grids yet</li>}
        row={(id, lineBefore) => (
          <GridRow
            key={id}
            id={id}
            lineBefore={lineBefore}
            editing={editing === id}
            hint={hint}
            register={register}
            onOpen={choose}
            onRenamed={renamed}
            onStartRename={setEditing}
            onNudge={nudge}
            onMenu={openMenu}
          />
        )}
      />
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
      {menu && menuGrid && (
        <Menu
          label={`${menuGrid.name} options`}
          at={menu.at}
          entries={entries(menuGrid)}
          onClose={(refocus) => {
            if (refocus) menu.from?.focus();
            setMenu(null);
          }}
        />
      )}
      {deleting && deletingGrid && (
        <Confirm title={`Delete “${deletingGrid.name}”?`} action="Delete grid" onConfirm={() => removeGrid(deletingGrid)} onClose={() => setDeleting(null)}>
          <p className="muted">{deleteNote(deletingGrid, hostedIn(deletingGrid).length)}</p>
        </Confirm>
      )}
    </SideSection>
  );
}

/** The terminals grid `g`'s session panes keep open, shown in place of
 *  the terminals they run in (see `hostedBy`). */
const hostedIn = (g: Grid): string[] => g.panes.flatMap((p) => hostedBy(g.id, p.id) ?? []);

/** What deleting a grid does to what's in it; `hosted` of its sessions
 *  are shown in place of the terminals they run in, which close with it. */
export const deleteNote = (g: Grid, hosted = 0): string => {
  const terminals = g.panes.filter((p) => p.content?.kind === "terminal").length + hosted;
  const others = g.panes.filter((p) => p.content && p.content.kind !== "terminal").length - hosted;
  const parts = [];
  if (others) parts.push(`Its ${others === 1 ? "session or agent stays" : `${others} sessions and agents stay`} where ${others === 1 ? "it is" : "they are"}, just off this grid.`);
  if (terminals) parts.push(`${terminals === 1 ? "Its terminal closes" : `Its ${terminals} terminals close`}, with anything running in ${terminals === 1 ? "it" : "them"}.`);
  return parts.join(" ") || "It's empty.";
};
