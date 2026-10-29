import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { Menu, type MenuEntry } from "../ui/Menu";
import { useGridDrag } from "./drag";
import { PRESETS, presetOf, splitterKey, splitterRange, splitters, STEPS, type Pane, type Preset, type PresetId, type Splitter } from "./engine";
import { GridPane } from "./Pane";
import { closePane, dragSplitter, layOut, newTerminal, renameGrid, unparkPane, useGrids } from "./store";
import { closeContent, trackedIn, useTerminals } from "./terminals";
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
  const terminals = useTerminals((s) => s.byId);
  let working = 0;
  let needsYou = 0;
  const shown = grid?.panes.filter((p) => p.rect) ?? [];
  for (const p of shown) {
    const c = p.content;
    let s: Session | null | undefined = null;
    if (c?.kind === "session") s = sessions[c.sessionId];
    else if (c?.kind === "terminal") s = trackedIn(sessions, c.terminalId, c.terminalId ? terminals[c.terminalId] : undefined);
    else if (c?.kind === "agent" && conversations[c.agent]?.working) working += 1;
    if (s?.state === "blocked") needsYou += 1;
    else if (s?.state === "working" || s?.state === "starting") working += 1;
  }
  return { panes: shown.length, working, needsYou };
}

export const countsLine = (c: { panes: number; working: number; needsYou: number }): string =>
  [`${c.panes} ${c.panes === 1 ? "pane" : "panes"}`, c.working ? `${c.working} working` : "", c.needsYou ? `${c.needsYou} needs you` : ""].filter(Boolean).join(" · ");

/** Panes this grid has parked (out of the layout, still running), to bring
 *  back or close. */
export function ParkedButton({ grid }: { grid: Grid }) {
  const parked = grid.panes.filter((p) => !p.rect && p.content);
  const [menu, setMenu] = useState<{ x: number; y: number; from: HTMLElement } | null>(null);
  const sessions = useDesk((s) => s.sessions);
  const roster = useChat((s) => s.roster);
  if (!parked.length) return null;
  const name = (p: Pane): string => {
    const c = p.content!;
    if (c.kind === "session") return sessions[c.sessionId]?.name ?? "Session";
    if (c.kind === "agent") return roster.find((a) => `${a.hubId}/${a.id}` === c.agent)?.name ?? "Agent";
    return c.cwd ? `Terminal · ${c.cwd.split("/").filter(Boolean).pop() ?? "~"}` : "Terminal";
  };
  const entries: MenuEntry[] = parked.map((p) => ({
    kind: "item",
    label: name(p),
    submenu: [
      { kind: "item", label: "Bring back", onSelect: () => unparkPane(grid.id, p.id) },
      { kind: "item", label: p.content?.kind === "terminal" ? "Close terminal" : "Remove", onSelect: () => closePane(grid.id, p.id, closeContent) },
    ],
  }));
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost gbtn"
        aria-haspopup="menu"
        title="Out of this layout, still running"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 4, from: e.currentTarget });
        }}
      >
        {parked.length} parked
      </button>
      {menu && (
        <Menu
          label="Parked panes"
          at={menu}
          entries={entries}
          onClose={(refocus) => {
            if (refocus) menu.from.focus();
            setMenu(null);
          }}
        />
      )}
    </>
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
          else if (e.key === "Escape") done(false);
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
  const dragging = useGridDrag((s) => s.item !== null);
  const area = useRef<HTMLDivElement>(null);
  return (
    <div className="gcanvas" data-drop-grid={grid.id}>
      <div className="gcanvas-inner" ref={area}>
        {grid.panes.map((p) => (
          <GridPane key={p.id} gridId={grid.id} pane={p} focused={focus === p.id} />
        ))}
        {splitters(grid.panes).map((s) => (
          <SplitterHandle key={splitterKey(s)} grid={grid} splitter={s} area={area} />
        ))}
      </div>
      {dragging && <PresetStrip gridId={grid.id} />}
    </div>
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

