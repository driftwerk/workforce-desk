import { useState, type CSSProperties, type ReactNode } from "react";
import { openAgentSettings } from "../rooms/AgentPanel";
import { createPortal } from "react-dom";
import { useChat } from "../chat/store";
import { agentKey } from "../chat/types";
import { useSessionName, useSessionNames } from "../groups/names";
import { sortedSessions, useDesk } from "../hub/store";
import type { Session, SessionState } from "../hub/types";
import { DirectMessage } from "../rooms/Rooms";
import { sessionAction, type SessionAction } from "../session/actions";
import { Approval } from "../session/Approval";
import { SessionBody } from "../session/SessionCard";
import { Terminal } from "../session/Terminal";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { CloseButton, Dialog } from "../ui/Dialog";
import { Menu, type MenuEntry } from "../ui/Menu";
import { paneJustDragged, useGridDrag, usePaneDrag } from "./drag";
import { parkedOrder, STEPS, type Pane as PaneData, type PaneContent, type Rect, type Zone } from "./engine";
import { closePane, createGrid, flashDone, movePane, newTerminal, replacePane, setFocus, swapInPane, toggleFill, unfill, useGrids, writes } from "./store";
import { FocusIcon, UnfocusIcon } from "../panels/Stage";
import { closeContent, describeTerminal, reopenTerminal, trackedIn, useTerminalPane, useTerminals } from "./terminals";
import type { Grid } from "./model";
import { AgentMark } from "../ui/Mark";

const ENGINE: Record<Session["engine"], string> = { claude: "Claude Code", codex: "Codex" };

export const STATE_LABEL: Record<SessionState, string> = {
  starting: "starting",
  working: "working",
  blocked: "needs you",
  done: "done",
  idle: "idle",
  interrupted: "interrupted",
  stopped: "stopped",
  closed: "closed",
};

/** Where a pane sits: its share of the grid, with half the gap around it. */
export const boxStyle = (rect: Rect | null): CSSProperties =>
  rect
    ? {
        left: `${(rect.x / STEPS) * 100}%`,
        top: `${(rect.y / STEPS) * 100}%`,
        width: `${(rect.w / STEPS) * 100}%`,
        height: `${(rect.h / STEPS) * 100}%`,
      }
    : { display: "none" };

const ZONE_LABEL: Record<Zone, string> = { left: "Left half", right: "Right half", top: "Top half", bottom: "Bottom half", center: "Replace" };

/** What a pane's header says. */
export interface Label {
  name: string;
  meta: string;
  /** Its dot: a session's state, or none. */
  state: SessionState | null;
  /** A session started in this terminal that Desk tracks. */
  tracked: Session | null;
  /** The session to answer for, if it's asking. */
  asking: Session | null;
  cwd: string | null;
  mono: boolean;
}

const home = (path: string | null | undefined): string | null => (path ? path.replace(/^\/Users\/[^/]+/, "~") : null);
const folder = (path: string | null | undefined): string | null => path?.split("/").filter(Boolean).pop() ?? null;

/** Each pane's header, from what it holds. */
export function usePaneLabel(content: PaneContent | null): Label {
  const sessions = useDesk((s) => s.sessions);
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  const working = useChat((s) => (content?.kind === "agent" ? (s.conversations[content.agent]?.working ?? null) : null));
  const info = useTerminals((s) => (content?.kind === "terminal" && content.terminalId ? s.byId[content.terminalId] : undefined));
  const programs = useTerminals((s) => (content?.kind === "terminal" && content.terminalId ? s.programs[content.terminalId] : undefined));
  const sessionId = content?.kind === "session" ? content.sessionId : null;
  const tracked = content?.kind === "terminal" ? trackedIn(sessions, content.terminalId) : null;
  const session = sessionId ? sessions[sessionId] : tracked;
  const name = useSessionName(session?.id, session?.name ?? "");
  if (!content) return { name: "Empty pane", meta: "", state: null, tracked: null, asking: null, cwd: null, mono: false };
  if (content.kind === "agent") {
    const agent = roster.find((a) => agentKey(a) === content.agent);
    const hub = hubs.find((h) => h.id === agent?.hubId);
    return {
      name: agent?.name ?? content.agent.split("/").pop() ?? "Agent",
      meta: [hub?.label ?? "Agent", working ? "working" : "idle"].join(" · "),
      state: working ? "working" : "idle",
      tracked: null,
      asking: null,
      cwd: null,
      mono: false,
    };
  }
  if (session) {
    return {
      name,
      meta: `${ENGINE[session.engine]} · ${STATE_LABEL[session.state]}`,
      state: session.state,
      tracked,
      asking: session.pending ? session : null,
      cwd: content.kind === "terminal" ? home(info?.cwd ?? content.cwd) : null,
      mono: true,
    };
  }
  if (content.kind === "session") return { name: "Session", meta: "no longer on the hub", state: "closed", tracked: null, asking: null, cwd: null, mono: true };
  const t = describeTerminal(info, programs);
  const cwd = info?.cwd ?? content.cwd ?? null;
  return {
    name: t.codex ? "Codex" : t.claude ? "Claude Code" : ["Terminal", folder(cwd)].filter(Boolean).join(" · "),
    meta: t.running ? `${t.shell} → ${t.running}` : t.shell,
    state: null,
    tracked: null,
    asking: null,
    cwd: home(cwd),
    mono: true,
  };
}

/** Taking pane `pane` out of the grid: a session or a conversation just
 *  leaves it (nothing ends); a terminal with something still running in it
 *  asks first, as closing it ends that. */
function useRemovePane(gridId: string, pane: PaneData, label: Label): { remove: () => void; dialog: ReactNode } {
  const [confirm, setConfirm] = useState(false);
  const running = useTerminals((s) =>
    pane.content?.kind === "terminal" && pane.content.terminalId ? describeTerminal(s.byId[pane.content.terminalId], s.programs[pane.content.terminalId]).running : null,
  );
  const remove = () => {
    const busy = pane.content?.kind === "terminal" && (label.tracked || running);
    if (busy) setConfirm(true);
    else closePane(gridId, pane.id, closeContent);
  };
  const dialog = confirm && (
    <Dialog
      onClose={() => setConfirm(false)}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-md">
              Close this terminal?
            </h1>
            <p>{label.tracked ? `${label.name} is still running in it, and stops when it closes.` : `${running ?? "A program"} is still running in it.`}</p>
          </span>
          <CloseButton onClose={() => setConfirm(false)} />
        </header>
      )}
    >
      <footer className="dialog-foot">
        <button type="button" className="btn btn-ghost" data-autofocus onClick={() => setConfirm(false)}>
          Keep it
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            setConfirm(false);
            closePane(gridId, pane.id, closeContent);
          }}
        >
          Close terminal
        </button>
      </footer>
    </Dialog>
  );
  return { remove, dialog };
}

/** What removing a pane is called: a terminal closes; anything else only
 *  leaves the grid. */
const removeLabel = (pane: PaneData): string => (pane.content?.kind === "terminal" ? "Close terminal" : pane.content ? "Remove from grid" : "Close pane");

const RemoveIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </svg>
);

/** One pane: its header (state, name, what it is, its options, and taking
 *  it off the grid) and what it holds — a session, a conversation, a
 *  terminal, or nothing yet. Its header drags it. */
/** The whole grid, for a pane filling it. */
const WHOLE: CSSProperties = { left: 0, top: 0, width: "100%", height: "100%" };

export function GridPane({
  gridId,
  pane,
  focused,
  alone,
  fill = null,
}: {
  gridId: string;
  pane: PaneData;
  focused: boolean;
  alone: boolean;
  /** While a pane fills the grid: this one, with how many others wait
   *  hidden, or one of those. */
  fill?: { waiting: number } | "hidden" | null;
}) {
  const fillKeys = useSettings((s) => s.keys.fillPane);
  const label = usePaneLabel(pane.content);
  const over = useGridDrag((s) => (s.over && s.over.kind !== "new" && s.over.gridId === gridId ? s.over : null));
  const dragging = useGridDrag((s) => s.item !== null);
  const movingPane = useGridDrag((s) => !!s.item?.from);
  const swapping = useGridDrag((s) => !!s.item?.from?.parked);
  const lifted = useGridDrag((s) => s.item?.from?.gridId === gridId && s.item.from.paneId === pane.id);
  const flash = useGrids((s) => (s.flash?.gridId === gridId && s.flash.paneId === pane.id ? s.flash.n : 0));
  const [menu, setMenu] = useState<{ x: number; y: number; from: HTMLElement | null } | null>(null);
  const { remove, dialog } = useRemovePane(gridId, pane, label);
  const session = useDesk((s) => (pane.content?.kind === "session" ? s.sessions[pane.content.sessionId] : undefined)) ?? label.tracked;
  const action = session ? sessionAction(session) : null;
  const entries = usePaneMenu(gridId, pane, action, remove);
  const handle = usePaneDrag(gridId, pane, label.name);
  const zone = over?.kind === "pane" && over.paneId === pane.id ? over.zone : null;
  const free = over?.kind === "free";
  return (
    <section
      className={`gpane ${focused ? "gpane-focused" : ""} ${label.asking ? "gpane-asking" : ""} ${pane.content ? "" : "gpane-vacant"} ${lifted ? "gpane-lifted" : ""} ${fill && fill !== "hidden" ? "gpane-filling" : ""}`}
      style={fill === "hidden" ? { display: "none" } : fill ? WHOLE : boxStyle(pane.rect)}
      aria-label={label.name}
      data-drop-pane={pane.id}
      data-grid={gridId}
      onPointerDownCapture={() => setFocus(gridId, pane.id)}
      onFocusCapture={() => setFocus(gridId, pane.id)}
    >
      <div className="gpane-box">
        <header className={`gpane-head ${pane.content ? "gpane-handle" : ""}`} title={pane.content ? "Drag to move" : undefined} onPointerDown={handle.onPointerDown}>
          <span className={`dot ${label.state ? `dot-${label.state}` : "dot-none"}`} aria-hidden="true" />
          {pane.content?.kind === "agent" && <AgentMark agent={pane.content.agent} name={label.name} size="xs" />}
          <span className={`gpane-name ${label.mono ? "mono" : ""}`}>{label.name}</span>
          {label.meta && <span className={`gpane-meta ${label.state === "blocked" ? "state-blocked" : ""}`}>{label.meta}</span>}
          {label.tracked && <span className="gpane-badge">Tracked — on the Floor</span>}
          <span className="gpane-fill" />
          {label.cwd && <span className="gpane-cwd mono">{label.cwd}</span>}
          {fill && fill !== "hidden" ? (
            <>
              <span className="gpane-waiting">
                {fill.waiting} other {fill.waiting === 1 ? "pane" : "panes"} waiting
              </span>
              <button type="button" className="icon-btn-sm" aria-label="Back to the grid" title="Back to the grid (Esc)" onClick={() => unfill(gridId)}>
                <UnfocusIcon />
              </button>
            </>
          ) : (
            pane.rect &&
            !alone && (
              <button
                type="button"
                className="icon-btn-sm"
                aria-label="Fill the grid"
                title={`Fill the grid (${shortcutLabel(fillKeys)})`}
                onClick={() => toggleFill(gridId, pane.id)}
              >
                <FocusIcon />
              </button>
            )
          )}
          {action && (
            <button type="button" className="link small gpane-act" onClick={action.run}>
              {action.label}
            </button>
          )}
          <button
            type="button"
            className="icon-btn-sm"
            aria-label="Pane options"
            title="Pane options"
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 2, from: e.currentTarget });
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <circle cx="3" cy="7" r="1.3" />
              <circle cx="7" cy="7" r="1.3" />
              <circle cx="11" cy="7" r="1.3" />
            </svg>
          </button>
          {!(alone && !pane.content) && (
            <button type="button" className="icon-btn-sm gpane-remove" aria-label="Remove from grid" title="Remove from grid" onClick={remove}>
              <RemoveIcon />
            </button>
          )}
        </header>
        <div className="gpane-body">
          <PaneBody gridId={gridId} pane={pane} />
        </div>
        {label.asking && <Approval session={label.asking} />}
        {dragging && (zone || free) && <DropZones zone={zone} free={!!free} single={movingPane && !pane.content ? "Move here" : swapping ? "Swap in" : null} />}
        {flash > 0 && <span key={flash} className="gpane-flash" aria-hidden="true" onAnimationEnd={() => flashDone(flash)} />}
      </div>
      {menu && (
        <Menu
          label={`${label.name} options`}
          at={menu}
          entries={entries}
          onClose={(refocus) => {
            if (refocus) menu.from?.focus();
            setMenu(null);
          }}
        />
      )}
      {dialog}
    </section>
  );
}

/** A pane being dragged: its name, following the pointer. */
export function PaneDragChip({ gridId }: { gridId: string }) {
  const item = useGridDrag((s) => (s.item?.from?.gridId === gridId ? s.item : null));
  const at = useGridDrag((s) => s.at);
  if (!item || !at) return null;
  return createPortal(
    <div className="drag-chip gpane-chip" style={{ left: at.x + 12, top: at.y + 8 }} aria-hidden="true">
      {item.name}
    </div>,
    document.body,
  );
}

/** The panes a layout had no room for, still running: click one to swap it
 *  in, or drag it onto a pane. */
export function ParkedTray({ grid }: { grid: Grid }) {
  const parked = parkedOrder(grid.panes);
  if (!parked.length) return null;
  return (
    <div className="gtray" role="region" aria-label={`Parked (${parked.length})`}>
      <span className="gtray-label small">Parked ({parked.length})</span>
      <ul className="gtray-list">
        {parked.map((p) => (
          <ParkedItem key={p.id} gridId={grid.id} pane={p} />
        ))}
      </ul>
    </div>
  );
}

function ParkedItem({ gridId, pane }: { gridId: string; pane: PaneData }) {
  const label = usePaneLabel(pane.content);
  const { remove, dialog } = useRemovePane(gridId, pane, label);
  const handle = usePaneDrag(gridId, pane, label.name);
  const asking = !!label.asking;
  return (
    <li className={`gtray-item ${asking ? "gtray-asking" : ""}`}>
      <button
        type="button"
        className="gtray-chip"
        data-drag-handle
        title="Click to swap it in, or drag it onto a pane"
        onPointerDown={handle.onPointerDown}
        onClick={() => !paneJustDragged() && swapInPane(gridId, pane.id)}
      >
        <span className={`dot ${label.state ? `dot-${label.state}` : "dot-none"}`} aria-hidden="true" />
        <span className={`gtray-name ${label.mono ? "mono" : ""}`}>{label.name}</span>
        {asking && <span className="state-blocked small">needs you</span>}
      </button>
      <button type="button" className="icon-btn-sm gtray-remove" aria-label={`Remove ${label.name} from grid`} title="Remove from grid" onClick={remove}>
        <RemoveIcon />
      </button>
      {dialog}
    </li>
  );
}

/** Where a drop would go: a side splits the pane, the middle replaces it. */
function DropZones({ zone, free, single }: { zone: Zone | null; free: boolean; single: string | null }) {
  if (free || single) {
    return (
      <div className="gzones" aria-hidden="true">
        <div className="gzone gzone-free on">{single ?? "Next free place"}</div>
      </div>
    );
  }
  return (
    <div className="gzones" aria-hidden="true">
      {(["left", "right", "top", "bottom", "center"] as const).map((z) => (
        <div key={z} className={`gzone gzone-${z} ${zone === z ? "on" : ""}`}>
          {zone === z ? ZONE_LABEL[z] : z === "center" ? "Replace" : ""}
        </div>
      ))}
    </div>
  );
}

function PaneBody({ gridId, pane }: { gridId: string; pane: PaneData }) {
  const c = pane.content;
  const keys = useSettings((s) => s.keys.newTerminal);
  if (!c) {
    return (
      <div className="gpane-empty">
        <p className="muted small">Drop a session here, or press {shortcutLabel(keys)} for a terminal.</p>
      </div>
    );
  }
  if (c.kind === "terminal") return <TerminalBody gridId={gridId} pane={pane.id} content={c} />;
  if (c.kind === "agent") return <DirectMessage agent={c.agent} />;
  return <SessionPane id={c.sessionId} />;
}

function SessionPane({ id }: { id: string }) {
  const session = useDesk((s) => s.sessions[id]);
  if (!session) {
    return (
      <div className="gpane-empty">
        <p className="muted small">This session is no longer on the hub.</p>
      </div>
    );
  }
  return <SessionBody session={session} autoFocus={false} />;
}

function TerminalBody({ gridId, pane, content }: { gridId: string; pane: string; content: Extract<PaneContent, { kind: "terminal" }> }) {
  const { info, known } = useTerminalPane(gridId, pane, content);
  const problem = useTerminals((s) => s.problems[pane]);
  const note = (text: string, action?: { label: string; run: () => void }) => (
    <div className="gpane-empty">
      <p className="muted small">
        {text}
        {action && (
          <>
            {" "}
            <button type="button" className="link small" onClick={action.run}>
              {action.label}
            </button>
          </>
        )}
      </p>
    </div>
  );
  if (problem) return note(problem);
  if (!content.terminalId || (known && !info)) return note(writes(gridId) ? "Opening a terminal…" : "Waiting for the terminal…");
  // Its shell ended (`exit`): it opens again where it was when asked.
  if (info && !info.live && info.state === "exited") {
    return note(`The shell ended${info.exitCode ? ` (exit ${info.exitCode})` : ""}.`, {
      label: "Open it again",
      run: () => void reopenTerminal(pane, info.id),
    });
  }
  if (info && !info.live) return note("Opening the terminal again…");
  return <Terminal key={content.terminalId} terminalId={content.terminalId} autoFocus={false} />;
}

/** A pane's options: close, replace, move to another grid. */
function usePaneMenu(gridId: string, pane: PaneData, action: SessionAction | null, onClose: () => void): MenuEntry[] {
  const sessions = useDesk((s) => s.sessions);
  const roster = useChat((s) => s.roster);
  // Selected as they're kept (a list made in the selector would be new on
  // every read, which zustand takes for a change).
  const order = useGrids((s) => s.order);
  const all = useGrids((s) => s.grids);
  const grids = order.flatMap((id) => all[id] ?? []);
  const role = useGrids((s) => s.role);
  const keys = useSettings((s) => s.keys.newTerminal);
  // Sessions by the names given them, as the sidebar shows them.
  const names = useSessionNames();
  const shown = sortedSessions(sessions).filter((s) => s.state !== "closed");
  const put = (content: PaneContent) => replacePane(gridId, pane.id, content);
  const replace: MenuEntry[] = [
    { kind: "item", label: "New terminal", kbd: shortcutLabel(keys), onSelect: () => (pane.content ? put({ kind: "terminal", terminalId: null }) : newTerminal(gridId)) },
    ...(shown.length ? [{ kind: "separator" as const }] : []),
    ...shown.slice(0, 12).map((s): MenuEntry => ({ kind: "item", label: names[s.id] ?? s.name, kbd: STATE_LABEL[s.state], onSelect: () => put({ kind: "session", sessionId: s.id }) })),
    ...(roster.length ? [{ kind: "separator" as const }] : []),
    ...roster.slice(0, 12).map((a): MenuEntry => ({ kind: "item", label: a.name, onSelect: () => put({ kind: "agent", agent: agentKey(a) }) })),
  ];
  const others = grids.filter((g) => g.id !== gridId);
  const move: MenuEntry[] = [
    ...others.map((g): MenuEntry => ({ kind: "item", label: g.name, onSelect: () => movePane(gridId, pane.id, g.id) })),
    ...(role.kind === "main"
      ? [
          ...(others.length ? [{ kind: "separator" as const }] : []),
          {
            kind: "item" as const,
            label: "New grid",
            onSelect: () => {
              const was = useGrids.getState().active;
              const id = createGrid();
              movePane(gridId, pane.id, id);
              useGrids.setState({ active: was === gridId ? id : was });
            },
          },
        ]
      : []),
  ];
  const agent = pane.content?.kind === "agent" ? pane.content.agent : null;
  return [
    { kind: "item", label: pane.content ? "Replace" : "Put here", submenu: replace },
    ...(pane.content && move.length ? [{ kind: "item" as const, label: "Move to grid", submenu: move }] : []),
    ...(action ? [{ kind: "item" as const, label: action.label, onSelect: action.run }] : []),
    ...(agent && role.kind === "main" ? [{ kind: "item" as const, label: "Agent settings", onSelect: () => openAgentSettings(agent) }] : []),
    { kind: "separator" },
    { kind: "item", label: removeLabel(pane), onSelect: onClose },
  ];
}
