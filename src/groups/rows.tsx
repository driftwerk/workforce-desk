// The sidebar's draggable rows, as the groups show them: a grip on hover,
// indented under their header, a line where a dragged one would land and a
// chip following the pointer. Groups' agents and sessions, grids and rooms
// are all drawn with these.

import { Accessibility, defaultPreset, PointerSensor } from "@dnd-kit/dom";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/react";
import { useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";

/** Only the pointer drags: the keyboard moves with Alt+↑/↓ and the menus,
 *  and Desk says so itself, so the library's keyboard dragging and its
 *  instructions are left out. */
export const SENSORS = [PointerSensor];
// Module-level, so a provider sees the same lists every render (it
// reapplies them whenever they change).
export const PLUGINS = defaultPreset.plugins.filter((p) => p !== Accessibility);

export type Operation = Parameters<NonNullable<ComponentProps<typeof DragDropProvider>["onDragMove"]>>[0]["operation"];

/** Where a menu opened from the keyboard appears: under what it's for. */
export const below = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + 12, y: r.bottom + 2 };
};

export const isMenuKey = (e: KeyboardEvent) => e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);

/** Alt+↑ or Alt+↓: which way to move. */
export const step = (e: KeyboardEvent): -1 | 1 | null =>
  e.altKey && !e.metaKey && !e.ctrlKey ? (e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : null) : null;

export function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="7" r="1.3" />
      <circle cx="7" cy="7" r="1.3" />
      <circle cx="11" cy="7" r="1.3" />
    </svg>
  );
}

/** The grip a row shows while it's hovered or focused. */
export function Grip() {
  return (
    <span className="gi-handle" aria-hidden="true">
      <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">
        <circle cx="2" cy="2" r="1" />
        <circle cx="6" cy="2" r="1" />
        <circle cx="2" cy="6" r="1" />
        <circle cx="6" cy="6" r="1" />
        <circle cx="2" cy="10" r="1" />
        <circle cx="6" cy="10" r="1" />
      </svg>
    </span>
  );
}

/** Where a dragged row would land. */
export function DropLine() {
  return <li className="drop-line" aria-hidden="true" />;
}

/** What follows the pointer while a row is dragged. */
export function DragChip({ mono, children }: { mono?: boolean; children: ReactNode }) {
  return <div className={`drag-chip ${mono ? "mono" : ""}`}>{children}</div>;
}

/** One row: click to open, drag (or Alt+↑/↓) to move, double-click or F2
 *  to rename when it can be, right-click or Shift+F10 for its menu, which
 *  a ⋯ on hover opens too when `more` names it. */
export function SortRow({
  id,
  type,
  collisionPriority,
  lineBefore,
  on,
  className = "",
  editing,
  lead,
  name,
  nameClass = "",
  meta,
  title,
  describedBy,
  more,
  wrap,
  data,
  register,
  onOpen,
  onStartRename,
  onNudge,
  onMenu,
  onHover,
  children,
}: {
  /** dnd-kit's id, and what `register` and the drop line know it by. */
  id: string;
  /** Rows only take rows of their own type. */
  type: string;
  collisionPriority?: number;
  lineBefore: boolean;
  on: boolean;
  className?: string;
  /** The rename field, in place of the row while it's renamed. */
  editing?: ReactNode;
  /** A dot or a mark before the name. */
  lead?: ReactNode;
  name: string;
  nameClass?: string;
  meta?: ReactNode;
  title?: string;
  describedBy?: string;
  /** The ⋯ button's label (none: no ⋯). */
  more?: string;
  /** Attributes for the row's list item. */
  wrap?: Record<`data-${string}`, string>;
  /** Attributes for the row's button. */
  data?: Record<`data-${string}`, string>;
  register: (el: HTMLElement | null) => void;
  onOpen: () => void;
  onStartRename?: () => void;
  onNudge: (by: -1 | 1) => void;
  onMenu: (at: { x: number; y: number }, from: HTMLElement | null) => void;
  /** The pointer came onto it (true), or left it (false). */
  onHover?: (over: boolean) => void;
  /** After the name and meta: a badge. */
  children?: ReactNode;
}) {
  const row = useRef<HTMLButtonElement | null>(null);
  const drag = useDraggable({ id, type, element: row, disabled: !!editing });
  useDroppable({ id, type, accept: type, element: row, collisionPriority });
  return (
    <>
      {lineBefore && <DropLine />}
      <li className={`gi-wrap ${more ? "side-item" : ""} ${drag.isDragSource ? "ghost" : ""} ${editing ? "editing" : ""}`} {...wrap}>
        {editing ? (
          <span className="gi gi-editing">
            <span className="gi-handle" aria-hidden="true" />
            {lead}
            {editing}
          </span>
        ) : (
          <button
            ref={(el) => {
              row.current = el;
              register(el);
            }}
            type="button"
            className={`gi ${on ? "on" : ""} ${className}`}
            title={title}
            aria-describedby={describedBy}
            aria-current={on ? "true" : undefined}
            {...data}
            onClick={onOpen}
            onPointerEnter={() => onHover?.(true)}
            onPointerLeave={() => onHover?.(false)}
            onDoubleClick={(e) => {
              if (!onStartRename) return;
              e.preventDefault();
              onStartRename();
            }}
            onKeyDown={(e) => {
              const by = step(e);
              if (by) {
                e.preventDefault();
                onNudge(by);
              } else if (e.key === "F2" && onStartRename) {
                e.preventDefault();
                onStartRename();
              } else if (isMenuKey(e)) {
                e.preventDefault();
                onMenu(below(e.currentTarget), e.currentTarget);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu({ x: e.clientX, y: e.clientY }, row.current);
            }}
          >
            <Grip />
            {lead}
            <span className={`gi-name ${nameClass}`}>{name}</span>
            {meta}
            {children}
          </button>
        )}
        {more && !editing && (
          <button
            type="button"
            className="icon-btn-sm side-more"
            aria-label={more}
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

/** A list of rows of one type, reordered by dragging: indented under its
 *  section's header as a group's items are, with the line where a dragged
 *  row would land. `row` draws each (with whether the line is before it);
 *  `onMove` puts `id` before `before`, or last when that's null. */
export function SortList({
  label,
  type,
  ids,
  chip,
  onMove,
  onDragStart,
  justDragged,
  empty,
  row,
}: {
  label: string;
  type: string;
  ids: string[];
  chip: (id: string) => ReactNode;
  onMove: (id: string, before: string | null) => void;
  onDragStart?: () => void;
  /** Set for a moment after a drag ends, so the click that follows isn't one. */
  justDragged?: { current: boolean };
  /** Shown when there are no rows. */
  empty?: ReactNode;
  row: (id: string, lineBefore: boolean) => ReactNode;
}) {
  const [before, setBefore] = useState<{ id: string | null } | null>(null);
  const dropFor = (op: Operation): { id: string | null } | null => {
    const { source, target } = op;
    if (!source || !target || source.type !== type) return null;
    const id = String(target.id);
    const rect = target.element?.getBoundingClientRect();
    const upper = rect ? op.position.current.y < rect.top + rect.height / 2 : true;
    return { id: upper ? id : (ids[ids.indexOf(id) + 1] ?? null) };
  };
  const show = (op: Operation) => {
    const d = dropFor(op);
    setBefore((was) => (was?.id === d?.id && !was === !d ? was : d));
  };
  return (
    <DragDropProvider
      sensors={SENSORS}
      plugins={PLUGINS}
      onDragStart={() => onDragStart?.()}
      onDragMove={(e) => show(e.operation)}
      onDragOver={(e) => show(e.operation)}
      onDragEnd={(e) => {
        const s = e.operation.source;
        const d = e.canceled ? null : dropFor(e.operation);
        setBefore(null);
        if (justDragged) {
          justDragged.current = true;
          setTimeout(() => (justDragged.current = false), 0);
        }
        if (!s || !d) return;
        const id = String(s.id);
        // Where it is already.
        if (d.id === id || ids[ids.indexOf(id) + 1] === d.id) return;
        onMove(id, d.id);
      }}
    >
      <div className="grp">
        <ul className="grp-items" aria-label={label}>
          {ids.map((id) => row(id, before?.id === id))}
          {before && before.id === null && <DropLine />}
          {!ids.length && empty}
        </ul>
      </div>
      <DragOverlay dropAnimation={null}>{(source) => <DragChip>{chip(String(source.id))}</DragChip>}</DragOverlay>
    </DragDropProvider>
  );
}
