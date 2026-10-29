import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { useGridDrag } from "./drag";
import { laidOut, PRESETS, presetOf, splitterKey, splitterRange, splitters, STEPS, type Preset, type PresetId, type Splitter } from "./engine";
import { GridPane, PaneDragChip, ParkedTray } from "./Pane";
import { dismissUndo, dragSplitter, filledPane, layOut, newTerminal, renameGrid, toggleFill, undoFor, undoLayout, unfill, useGrids } from "./store";
import { useAppShortcut } from "../shortcuts/manager";
import { inTerminal } from "../panels/Stage";
import { trackedIn } from "./terminals";
import type { Grid } from "./model";

/** A preset drawn small: its places as cells. */
export function PresetIcon({ preset, size = "sm" }: { preset: Preset; size?: "sm" | "lg" }) {
  return (
    <span className={`gpreset gpreset-${size}`} aria-hidden="true">
      {preset.rects.map((r, i) => (
        <span key={i} style={{ left: `${(r.x / STEPS) * 100}%`, top: `${(r.y / STEPS) * 100}%`, width: `${(r.w / STEPS) * 100}%`, height: `${(r.h / STEPS) * 100}%` }} />
      ))}
    </span>
  );
}

/** The layouts, as a radio group: the one the grid is now is checked. */
export function PresetPicker({ grid }: { grid: Grid }) {
  const now = presetOf(grid.panes);
  const pick = (id: PresetId) => layOut(grid.id, id);
  const onKey = (e: KeyboardEvent, i: number) => {
    const by = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!by) return;
    e.preventDefault();
    const next = PRESETS[(i + by + PRESETS.length) % PRESETS.length]!;
    pick(next.id);
    (e.currentTarget.parentElement?.children[PRESETS.indexOf(next)] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className="gpresets" role="radiogroup" aria-label="Layout">
      {PRESETS.map((p, i) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={now === p.id}
          aria-label={p.name}
          title={p.name}
          tabIndex={now === p.id || (!now && i === 0) ? 0 : -1}
          onClick={() => pick(p.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          <PresetIcon preset={p} />
        </button>
      ))}
    </div>
  );
}

/** What a grid's panes are doing: how many are working, and need you. */
export function useGridCounts(grid: Grid | undefined): { panes: number; working: number; needsYou: number } {
  const sessions = useDesk((s) => s.sessions);
  const conversations = useChat((s) => s.conversations);
  let working = 0;
  let needsYou = 0;
  const shown = grid?.panes.filter((p) => p.rect) ?? [];
  for (const p of shown) {
    const c = p.content;
    let s: Session | null | undefined = null;
    if (c?.kind === "session") s = sessions[c.sessionId];
    else if (c?.kind === "terminal") s = trackedIn(sessions, c.terminalId);
    else if (c?.kind === "agent" && conversations[c.agent]?.working) working += 1;
    if (s?.state === "blocked") needsYou += 1;
    else if (s?.state === "working" || s?.state === "starting") working += 1;
  }
  return { panes: shown.length, working, needsYou };
}

export const countsLine = (c: { panes: number; working: number; needsYou: number }): string =>
  [`${c.panes} ${c.panes === 1 ? "pane" : "panes"}`, c.working ? `${c.working} working` : "", c.needsYou ? `${c.needsYou} needs you` : ""].filter(Boolean).join(" · ");

/** How long "N items parked · Undo" stays after a layout change. */
const UNDO_MS = 10_000;

/** Right after a layout change parked panes: how many, and an undo that
 *  puts the grid back exactly as it was. */
export function LayoutUndo({ gridId }: { gridId: string }) {
  const undo = useGrids((s) => undoFor(s, gridId));
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => dismissUndo(gridId), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo, gridId]);
  if (!undo) return null;
  return (
    <span className="gundo small" role="status">
      {undo.parked} {undo.parked === 1 ? "item" : "items"} parked ·{" "}
      <button type="button" className="link small strong" onClick={() => undoLayout(gridId)}>
        Undo
      </button>
    </span>
  );
}

/** The grid's name; double-click (or Enter) to rename it. */
export function GridName({ grid, className }: { grid: Grid; className: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(grid.name);
  if (editing) {
    const done = (save: boolean) => {
      setEditing(false);
      if (save) renameGrid(grid.id, value);
    };
    return (
      <input
        className={`rename-field ${className}`}
        aria-label="Grid name"
        value={value}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => done(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") done(true);
          else if (e.key === "Escape") {
            e.preventDefault();
            done(false);
          }
        }}
      />
    );
  }
  return (
    <h1
      className={className}
      title="Double-click to rename"
      onDoubleClick={() => {
        setValue(grid.name);
        setEditing(true);
      }}
    >
      {grid.name}
    </h1>
  );
}

/** "New terminal ⌘T". */
export function NewTerminalButton({ gridId }: { gridId: string }) {
  const keys = useSettings((s) => s.keys.newTerminal);
  return (
    <button type="button" className="btn btn-ghost gbtn" onClick={() => newTerminal(gridId)}>
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <rect x="1.5" y="2" width="11" height="10" rx="2" />
        <path d="M4 5.5l2 1.5-2 1.5M7.5 9h2.5" />
      </svg>
      New terminal <kbd>{shortcutLabel(keys)}</kbd>
    </button>
  );
}

/** A grid's panes, one flat keyed list (a pane never moves in the DOM, so
 *  what it shows keeps going through every layout change), with the shared
 *  edges between them to drag, and while something is dragged here from the
 *  sidebar, the layouts to drop it on. */
export function GridCanvas({ grid }: { grid: Grid }) {
  const focus = useGrids((s) => s.focus[grid.id]);
  const filled = useGrids((s) => filledPane(s, grid.id));
  // Layouts to drop on are for what comes from the sidebar; a pane moves.
  const dragging = useGridDrag((s) => s.item !== null && !s.item.from);
  const area = useRef<HTMLDivElement>(null);
  const shown = laidOut(grid.panes).length;
  const alone = shown === 1;
  return (
    <>
      <div className="gcanvas" data-drop-grid={grid.id}>
        <div className={`gcanvas-inner ${filled ? "gcanvas-filled" : ""}`} ref={area}>
          {grid.panes.map((p) => (
            <GridPane
              key={p.id}
              gridId={grid.id}
              pane={p}
              focused={focus === p.id}
              alone={alone}
              fill={!filled ? null : filled === p.id ? { waiting: shown - 1 } : "hidden"}
            />
          ))}
          {!filled &&
            splitters(grid.panes).map((s) => <SplitterHandle key={splitterKey(s)} grid={grid} splitter={s} area={area} />)}
        </div>
        {dragging && <PresetStrip gridId={grid.id} />}
      </div>
      <ParkedTray grid={grid} />
      <PaneDragChip gridId={grid.id} />
    </>
  );
}

/** A shared edge between panes: drag it (or focus it and use the arrows) to
 *  move it a twelfth at a time. */
function SplitterHandle({ grid, splitter: s, area }: { grid: Grid; splitter: Splitter; area: React.RefObject<HTMLDivElement | null> }) {
  const [lo, hi] = splitterRange(grid.panes, s);
  const vertical = s.axis === "x";
  const at = (s.at / STEPS) * 100;
  const from = (s.from / STEPS) * 100;
  const len = ((s.to - s.from) / STEPS) * 100;
  // Each end stops short, so where edges meet each can still be taken.
  const style = vertical
    ? { left: `${at}%`, top: `calc(${from}% + 8px)`, height: `calc(${len}% - 16px)` }
    : { top: `${at}%`, left: `calc(${from}% + 8px)`, width: `calc(${len}% - 16px)` };
  const cursor = vertical ? "gsplitting-v" : "gsplitting-h";
  const stop = () => document.body.classList.remove(cursor);
  // However the drag ends — let go, taken away, or this edge gone.
  useEffect(() => () => document.body.classList.remove(cursor), [cursor]);
  const move = (e: PointerEvent) => {
    const r = area.current?.getBoundingClientRect();
    if (!r) return;
    const f = vertical ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    const to = Math.round(f * STEPS);
    if (to !== s.at) dragSplitter(grid.id, s, { at: to });
  };
  return (
    <div
      className={`gsplit ${vertical ? "gsplit-v" : "gsplit-h"}`}
      style={style}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={lo}
      aria-valuemax={hi}
      aria-valuenow={s.at}
      aria-label="Resize panes"
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.classList.add(cursor);
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && move(e)}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        stop();
      }}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={(e) => {
        const back = vertical ? "ArrowLeft" : "ArrowUp";
        const fwd = vertical ? "ArrowRight" : "ArrowDown";
        if (e.key !== back && e.key !== fwd) return;
        e.preventDefault();
        dragSplitter(grid.id, s, { by: e.key === fwd ? 1 : -1 });
      }}
    />
  );
}

/** While something is dragged over the grid: drop it on a place in a layout
 *  to lay the grid out that way with it there. */
function PresetStrip({ gridId }: { gridId: string }) {
  const over = useGridDrag((s) => (s.over?.kind === "preset" && s.over.gridId === gridId ? s.over : null));
  const free = useGridDrag((s) => s.free);
  return (
    <div className="gstrip" aria-hidden="true">
      <span className="gstrip-label">{free ? "⇧ held: drops in the next free place" : "Or drop on a layout"}</span>
      {PRESETS.filter((p) => p.id !== "one").map((p) => (
        <span key={p.id} className="gpreset gpreset-lg" title={p.name}>
          {p.rects.map((r, i) => (
            <span
              key={i}
              data-drop-preset={p.id}
              data-slot={i}
              data-grid={gridId}
              className={over?.preset === p.id && over.slot === i ? "on" : ""}
              style={{ left: `${(r.x / STEPS) * 100}%`, top: `${(r.y / STEPS) * 100}%`, width: `${(r.w / STEPS) * 100}%`, height: `${(r.h / STEPS) * 100}%` }}
            />
          ))}
        </span>
      ))}
    </div>
  );
}


/** The keys for filling grid `gridId` (while `enabled`: the grid is in
 *  sight): ⌘⇧↩ (as set in Settings) gives the focused pane the whole grid
 *  or gives it back; Esc gives it back, unless it was typed into a
 *  terminal, whose Esc is its own. */
export function useFillKeys(gridId: string | null, enabled: boolean) {
  useAppShortcut("fillPane", () => gridId && toggleFill(gridId), enabled && !!gridId);
  const filled = useGrids((s) => (gridId ? filledPane(s, gridId) : null));
  useEffect(() => {
    if (!enabled || !filled || !gridId) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || inTerminal(e.target)) return;
      e.preventDefault();
      unfill(gridId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, filled, gridId]);
}
