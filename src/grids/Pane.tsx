import { memo, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { OnMachine } from "../machines/OnMachine";
import { openAgentSettings } from "../rooms/AgentPanel";
import { createPortal } from "react-dom";
import { useChat } from "../chat/store";
import { agentKey } from "../chat/types";
import { lookOf, shownState, statusOf, type Look } from "../floor/background";
import { useSessionName, useSessionNames } from "../groups/names";
import { hubFor, hubOf, localSessions, sortedSessions, useDesk } from "../hub/store";
import { keyOf, machineOf, sessionKey, splitKey } from "../hub/machines";
import type { Session, SessionState } from "../hub/types";
import { DirectMessage } from "../rooms/Rooms";
import { MicBadge } from "../voice/DmVoice";
import { MemoryPanel } from "../memory/MemoryPanel";
import { SubjectHistory } from "../board/History";
import { SessionChrome, panelId, tabId, type SessionTab } from "../session/SessionChrome";
import { HubError } from "../hub/client";
import { plainError } from "../ui/plainError";
import { Approval } from "../session/Approval";
import { SessionBody } from "../session/SessionCard";
import { LinePanel } from "../line/LinePanel";
import { BreakerBanner } from "../spend/BreakerBanner";
import { DriverBar } from "../crew/ChargeBadge";
import { Terminal } from "../session/Terminal";
import { useSettings } from "../settings/store";
import { shortcutLabel, terminalKeys } from "../shortcuts/keys";
import { CloseButton, Dialog } from "../ui/Dialog";
import { Menu, type MenuEntry } from "../ui/Menu";
import { paneJustDragged, useGridDrag, usePaneDrag } from "./drag";
import { nameParts } from "./head";
import { BoardChips, BoardPaneBody, FloorMeta, FloorPaneBody, FloorPaneScope, KindIcon, RoomPaneBody, RoomPaneMarks, setPaneFilter, usePaneFilter, useViewLabel, type ViewLabel } from "./kinds";
import { FILTERS } from "../board/board";
import { PanePicker } from "./Picker";
import { useBoard } from "../board/store";
import { arrangedBoards, useBoardOrder } from "../board/order";
import { arranged, useRoomOrder } from "../rooms/order";
import { useLayout } from "../groups/store";
import { boardContent, floorContent, roomContent } from "./engine";
import { findContent, knownContent, parkedOrder, sessionContent, sessionKeyIn, STEPS, terminalContent, terminalKeyIn, type Pane as PaneData, type PaneContent, type Rect, type Zone } from "./engine";
import { closePane, createGrid, flashDone, hostedBy, movePane, newTerminal, replacePane, setFocus, swapInPane, toggleFill, unfill, useGrids, writes } from "./store";
import { FocusIcon, OutOfSight, UnfocusIcon, useOutOfSight } from "../panels/Stage";
import { useSeenSession } from "../unread/seen";
import { closeContent, describeTerminal, reopenTerminal, trackedIn, useTerminalPane, useTerminals } from "./terminals";
import type { Grid } from "./model";
import { AgentMark } from "../ui/Mark";
import { GroupChip } from "../groups/GroupChip";
import { itemOf } from "./where";
import { baseName, homeShort } from "../ui/paths";
import { withAccount } from "../engines/accounts";
import { ENGINE_TITLE } from "../engines/engines";

import { STATE_LABEL } from "../session/words";
import { setSectionOpen } from "../shell/SideSection";

const ENGINE = ENGINE_TITLE;

export { STATE_LABEL };

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
  state: Look | null;
  /** A session started in this terminal that Desk tracks. */
  tracked: Session | null;
  /** The session to answer for, if it's asking. */
  asking: Session | null;
  cwd: string | null;
  mono: boolean;
  /** A room, a board or the Floor: what its header says of it. */
  view?: ViewLabel;
}

const home = (path: string | null | undefined): string | null => (path ? homeShort(path) : null);
const folder = (path: string | null | undefined): string | null => (path ? baseName(path) : null);

/** Each pane's header, from what it holds. */
export function usePaneLabel(content: PaneContent | null): Label {
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  const working = useChat((s) => (content?.kind === "agent" ? (s.conversations[content.agent]?.working ?? null) : null));
  const terminal = terminalKeyIn(content);
  const info = useTerminals((s) => (terminal ? s.byId[terminal] : undefined));
  const programs = useTerminals((s) => (terminal ? s.programs[terminal] : undefined));
  const shows = sessionKeyIn(content);
  // Only the session this pane shows: another session's event leaves it be.
  const tracked = useDesk((s) => (content?.kind === "terminal" ? trackedIn(s.sessions, terminal) : null));
  const shown = useDesk((s) => (shows ? s.sessions[shows] : undefined));
  const session = shows ? shown : tracked;
  const name = useSessionName(session && sessionKey(session), session?.name ?? "");
  const view = useViewLabel(content);
  if (!content) return { name: "Empty pane", meta: "", state: null, tracked: null, asking: null, cwd: null, mono: false };
  if (view) return { name: view.name, meta: view.meta, state: null, tracked: null, asking: null, cwd: null, mono: false, view };
  // Kept by a newer Desk (grids follow the person through the hub).
  if (!knownContent(content)) return { name: "Pane from a newer Desk", meta: "update Desk to show it", state: null, tracked: null, asking: null, cwd: null, mono: false };
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
      meta: `${withAccount(ENGINE[session.engine], session)} · ${statusOf(session, STATE_LABEL)}`,
      state: lookOf(session),
      tracked,
      asking: session.pending || session.state === "asking" ? session : null,
      cwd: content.kind === "terminal" ? home(info?.cwd ?? content.cwd) : null,
      mono: true,
    };
  }
  if (content.kind !== "terminal") return { name: "Session", meta: "no longer running", state: "closed", tracked: null, asking: null, cwd: null, mono: true };
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

/** What closing a pane asks: its question, what closing does and doesn't,
 *  and the red button's label. */
interface CloseAsk {
  title: string;
  says: string;
  action: string;
}

/** Taking pane `pane` out of the grid, which always asks first, as a pane's
 *  close is easily taken for a sidebar item's. A session or a conversation
 *  just leaves it (nothing ends); a terminal closes, ending what runs in it.
 *  A session shown in place of the terminal it runs in, where no other pane
 *  shows that terminal, is that terminal here: it closes with the pane.
 *  `remove` takes the element focus goes back to if it's kept. */
function useRemovePane(gridId: string, pane: PaneData, label: Label): { remove: (from?: HTMLElement | null) => void; dialog: ReactNode } {
  const [confirm, setConfirm] = useState(false);
  const hosted = useGrids((s) => hostedBy(gridId, pane.id, s));
  const terminal = pane.content?.kind === "terminal" ? terminalKeyIn(pane.content) : hosted;
  const running = useTerminals((s) => (terminal ? describeTerminal(s.byId[terminal], s.programs[terminal]).running : null));
  const shows = sessionKeyIn(pane.content);
  const shown = useDesk((s) => (shows ? s.sessions[shows] : undefined));
  const inIt = label.tracked ?? (hosted && shown?.live ? shown : null);
  const close = () => closePane(gridId, pane.id, (c) => closeContent(hosted ? terminalContent(hosted) : c));
  const remove = (from?: HTMLElement | null) => {
    // Clicking a button doesn't focus it everywhere (WebKit): focused, it's
    // where the dialog puts focus back when it's kept.
    from?.focus();
    setConfirm(true);
  };
  const keep = () => setConfirm(false);
  const ask: CloseAsk =
    pane.content?.kind === "terminal" || hosted
      ? {
          title: "Close this terminal?",
          says: inIt
            ? `${label.name} is still running in it, and stops when it closes.`
            : running
              ? `${running} is still running in it.`
              : "Its shell stops when it closes.",
          action: "Close terminal",
        }
      : pane.content?.kind === "agent"
        ? { title: `Close ${label.name}’s pane?`, says: "The conversation stays; you can open it again from the sidebar.", action: "Close pane" }
        : label.view
          ? {
              title: `Close ${label.name}’s pane?`,
              says: label.view.gone
                ? "It’s no longer there, so nothing is lost."
                : `${label.view.kind === "room" ? "The room" : label.view.kind === "board" ? "The board" : "The Floor"} stays as it is; you can put it in a grid again from the sidebar.`,
              action: "Close pane",
            }
        : pane.content?.kind === "session"
          ? {
              title: "Close this pane?",
              says: !shown
                ? "The session is no longer running; nothing else changes."
                : shown.live
                  ? "The session keeps running."
                  : "The session stays as it is.",
              action: "Close pane",
            }
          : pane.content
            ? { title: "Close this pane?", says: "What it holds stays as it is.", action: "Close pane" }
            : { title: "Close this empty pane?", says: "It holds nothing, so nothing is lost.", action: "Close pane" };
  const dialog = confirm && (
    <Dialog
      onClose={keep}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              {ask.title}
            </h1>
            <p>{ask.says}</p>
          </span>
          <CloseButton onClose={keep} />
        </header>
      )}
    >
      <footer className="dialog-foot">
        {/* Focused, so Enter or Esc keeps it: only a deliberate choice closes. */}
        <button type="button" className="btn btn-ghost" data-autofocus onClick={keep}>
          Keep it
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            setConfirm(false);
            close();
          }}
        >
          {ask.action}
        </button>
      </footer>
    </Dialog>
  );
  return { remove, dialog };
}

/** What removing a pane is called: a terminal closes (and a session shown
 *  in place of its terminal, see `hostedBy`); anything else only leaves the
 *  grid. */
const removeLabel = (pane: PaneData, hosted: string | null): string =>
  pane.content?.kind === "terminal" || hosted ? "Close terminal" : pane.content ? "Remove from grid" : "Close pane";

const RemoveIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </svg>
);

/** A pane header's tooltip: all it says, however much of it shows, and
 *  that it drags. */
const headTitle = (label: Label, held: boolean): string | undefined => {
  if (!held) return undefined;
  const says = [label.name, label.meta, label.tracked && "Tracked — on the Floor", label.cwd].filter(Boolean).join(" · ");
  return `${says}\nDrag to move`;
};

/** The whole grid, for a pane filling it. */
const WHOLE: CSSProperties = { left: 0, top: 0, width: "100%", height: "100%" };

/** One pane: its header (state, name, what it is, its options, and taking
 *  it off the grid) and what it holds — a session, a conversation, a
 *  terminal, or nothing yet. Its header drags it. */
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
  const flash = useGrids((s) => (s.flash?.gridId === gridId && s.flash.paneIds.includes(pane.id) ? s.flash.n : 0));
  const [menu, setMenu] = useState<{ x: number; y: number; from: HTMLElement | null } | null>(null);
  const { remove, dialog } = useRemovePane(gridId, pane, label);
  const shows = sessionKeyIn(pane.content);
  // The session it shows, or the one tracked in its terminal: shown with
  // the session's own chrome, as in the side panel.
  const session = useDesk((s) => (shows ? s.sessions[shows] : undefined)) ?? label.tracked;
  const paneItem = useDesk((s) => itemOf(s.sessions, pane.content));
  const { entries, host, close } = usePaneMenu(gridId, pane, () => remove(menu?.from));
  const handle = usePaneDrag(gridId, pane, label.name);
  const zone = over?.kind === "pane" && over.paneId === pane.id ? over.zone : null;
  const free = over?.kind === "free";
  const [start, end] = nameParts(label.name);
  const said = useId();
  const [tab, setTab] = useState<SessionTab>("session");
  // A tracked session's terminal is that session on screen: seen as its
  // own pane is (a session's pane and a conversation read themselves).
  const box = useRef<HTMLElement | null>(null);
  const hidden = useOutOfSight();
  useSeenSession(pane.content?.kind === "terminal" ? label.tracked?.id : null, box, { enabled: !hidden && fill !== "hidden" });
  const filling = fill && fill !== "hidden" ? fill : null;
  const fillButton = filling ? (
    <>
      <span className="gpane-waiting">
        {filling.waiting} other {filling.waiting === 1 ? "pane" : "panes"} waiting
      </span>
      <button type="button" className="icon-btn-sm" aria-label="Back to the grid" title="Back to the grid (Esc)" onClick={() => unfill(gridId)}>
        <UnfocusIcon />
      </button>
    </>
  ) : (
    pane.rect &&
    !alone && (
      <button type="button" className="icon-btn-sm sc-fill-btn" aria-label="Fill the grid" title={`Fill the grid (${shortcutLabel(fillKeys)})`} onClick={() => toggleFill(gridId, pane.id)}>
        <FocusIcon />
      </button>
    )
  );
  const removeButton = !(alone && !pane.content) && (
    <button type="button" className="icon-btn-sm gpane-remove" aria-label="Remove from grid" title="Remove from grid" onClick={(e) => remove(e.currentTarget)}>
      <RemoveIcon />
    </button>
  );
  const head = session ? (
    <SessionChrome
      session={session}
      name={label.name}
      size="pane"
      tab={tab}
      onTab={setTab}
      tabIds={said}
      lead={fillButton}
      close={removeButton}
      // Fill is in the menu too, for a chrome too narrow for its button.
      hostEntries={pane.rect && !alone && !filling ? [{ kind: "item", label: "Fill the grid", kbd: shortcutLabel(fillKeys), onSelect: () => toggleFill(gridId, pane.id) }, ...host] : host}
      closeEntries={close}
      menuLabel="Pane options"
      headProps={{ className: "gpane-handle", title: headTitle(label, true), onPointerDown: handle.onPointerDown }}
      place={label.tracked && <span className="gpane-badge">Tracked — on the Floor</span>}
    />
  ) : (
    <header className={`gpane-head ${pane.content ? "gpane-handle" : ""}`} title={headTitle(label, !!pane.content)} onPointerDown={handle.onPointerDown}>
      {label.view ? <KindIcon kind={label.view.kind} /> : <span className={`dot ${label.state ? `dot-${label.state}` : "dot-none"}`} aria-hidden="true" />}
      {pane.content?.kind === "agent" && <AgentMark agent={pane.content.agent} name={label.name} size="xs" />}
      {pane.content?.kind === "agent" && <MicBadge agent={pane.content.agent} />}
      <span className={`gpane-name ${label.mono ? "mono" : ""}`}>
        <span className="gpane-name-start">{start}</span>
        {end && <span className="gpane-name-end">{end}</span>}
      </span>
      <OnMachine machine={machineOf(pane.content?.kind === "session" || pane.content?.kind === "terminal" ? pane.content : null)} />
      {paneItem && <GroupChip item={paneItem} />}
      {label.meta && (
        <span id={`${said}-meta`} className={`gpane-meta ${label.state === "blocked" ? "state-blocked" : ""}`}>
          {label.meta}
        </span>
      )}
      {pane.content?.kind === "floor" && !label.view?.gone && <FloorMeta id={`${said}-meta`} />}
      <span className="gpane-fill" />
      {pane.content?.kind === "room" && <RoomPaneMarks room={pane.content.room} />}
      {pane.content?.kind === "board" && !label.view?.gone && <BoardChips gridId={gridId} paneId={pane.id} />}
      {label.cwd && (
        <span id={`${said}-cwd`} className="gpane-cwd mono">
          {label.cwd}
        </span>
      )}
      {fillButton}
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
      {removeButton}
    </header>
  );
  const body = (
    // Behind a pane filling the grid: mounted, but nothing in it is read.
    <OutOfSight hidden={fill === "hidden"}>
      <PaneBody gridId={gridId} pane={pane} />
    </OutOfSight>
  );
  const shown = (
    <section
      ref={box}
      className={`gpane ${pane.content ? `gpane-k-${pane.content.kind}` : ""} ${session ? "gpane-chrome" : ""} ${focused ? "gpane-focused" : ""} ${label.asking ? "gpane-asking" : ""} ${pane.content ? "" : "gpane-vacant"} ${lifted ? "gpane-lifted" : ""} ${filling ? "gpane-filling" : ""}`}
      style={fill === "hidden" ? { display: "none" } : fill ? WHOLE : boxStyle(pane.rect)}
      aria-label={label.name}
      // What a narrow header no longer shows, still said.
      aria-describedby={session ? undefined : [(label.meta || pane.content?.kind === "floor") && `${said}-meta`, label.cwd && `${said}-cwd`].filter(Boolean).join(" ") || undefined}
      data-drop-pane={pane.id}
      data-grid={gridId}
      onPointerDownCapture={() => setFocus(gridId, pane.id)}
      onFocusCapture={() => setFocus(gridId, pane.id)}
    >
      <div className="gpane-box">
        {head}
        <div className="gpane-body">
          {session ? (
            <>
              {tab === "memory" && <MemoryPanel session={session} name={label.name} hub={hubFor(session)} id={panelId(said, "memory")} labelledBy={tabId(said, "memory")} />}
              {tab === "history" && (
                <div className="session-history-panel" role="tabpanel" id={panelId(said, "history")} aria-labelledby={tabId(said, "history")}>
                  <SubjectHistory subject={session.id} machine={machineOf(session)} label={`What ${label.name} did`} />
                </div>
              )}
              {/* The session itself stays mounted, hidden, while another tab shows. */}
              <div className="session-view" role="tabpanel" id={panelId(said, "session")} aria-labelledby={tabId(said, "session")} hidden={tab !== "session"}>
                {body}
              </div>
            </>
          ) : (
            body
          )}
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
  // A Floor pane reads the Floor once, for its header and its body.
  return pane.content?.kind === "floor" ? <FloorPaneScope group={pane.content.group ?? null}>{shown}</FloorPaneScope> : shown;
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
      <button type="button" className="icon-btn-sm gtray-remove" aria-label={`Remove ${label.name} from grid`} title="Remove from grid" onClick={(e) => remove(e.currentTarget)}>
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

/** What a pane holds. Drawn again only when the pane does: its header
 *  following a session's every event (or a menu's every change) leaves
 *  a conversation, a terminal or a board as it is. */
const PaneBody = memo(function PaneBody({ gridId, pane }: { gridId: string; pane: PaneData }) {
  const c = pane.content;
  if (!c) {
    return (
      <div className="gpane-empty gpane-picking">
        <PanePicker gridId={gridId} paneId={pane.id} />
      </div>
    );
  }
  switch (c.kind) {
    case "terminal":
      return <TerminalBody gridId={gridId} pane={pane.id} content={c} />;
    case "agent":
      return <DirectMessage key={c.agent} agent={c.agent} />;
    case "session":
      return <SessionPane id={sessionKeyIn(c)!} />;
    case "room":
      return <RoomPaneBody key={c.room} room={c.room} />;
    case "board":
      return <BoardPaneBody key={c.board} gridId={gridId} paneId={pane.id} board={c.board} />;
    case "floor":
      return <FloorPaneBody key={c.group ?? ""} group={c.group ?? null} />;
    default:
      return (
        <div className="gpane-empty">
          <p className="muted small">A newer Desk put this here. Update Desk to show it.</p>
        </div>
      );
  }
});

/** The session `id` (a key, see `keyOf`) in a pane. */
function SessionPane({ id }: { id: string }) {
  const session = useDesk((s) => s.sessions[id]);
  const [problem, setProblem] = useState<string | null>(null);
  if (!session) {
    // Closed (the hub lists only what's open) or removed: Resume finds out.
    const resume = () => {
      setProblem(null);
      const on = splitKey(id);
      const hub = hubOf(on.machine);
      // A machine Desk no longer reaches (let go, or not connected yet).
      if (!hub) return setProblem("Desk isn’t connected to the machine this session ran on, so it can’t resume it from here.");
      hub
        .resume(on.id)
        .catch((e) => setProblem(e instanceof HubError && e.status === 404 ? "It was removed from Desk, so there's nothing to resume." : plainError(e)));
    };
    return (
      <div className="gpane-empty">
        <p className="muted small">
          {problem ?? "This session is closed."}{" "}
          {!problem && (
            <button type="button" className="link small" onClick={resume}>
              Resume
            </button>
          )}
        </p>
      </div>
    );
  }
  return (
    <>
      <BreakerBanner sessionId={session.id} compact />
      <DriverBar session={session} />
      <SessionBody session={session} autoFocus={false} />
      <LinePanel session={session} />
    </>
  );
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
      run: () => void reopenTerminal(pane, info.id, machineOf(content)),
    });
  }
  if (info && !info.live) return note("Opening the terminal again…");
  return <Terminal key={terminalKeyIn(content)} terminalId={content.terminalId} machine={machineOf(content)} autoFocus={false} />;
}

/** A pane's options: close, replace, move to another grid. A session's
 *  pane shows them in the session's own menu (`host`, then `close`, after
 *  the session's), any other pane as `entries`. */
function usePaneMenu(gridId: string, pane: PaneData, onClose: () => void): { entries: MenuEntry[]; host: MenuEntry[]; close: MenuEntry[] } {
  // What to put here: this computer's sessions (a machine's are put in a
  // pane where they're shown with their machine), the first twelve, as one
  // line each, so another session's event redraws the pane only when it
  // changes what the menu lists.
  const listed = useDesk((s) =>
    JSON.stringify(
      sortedSessions(localSessions(s.sessions))
        .filter((x) => x.state !== "closed")
        .slice(0, 12)
        .map((x) => [x.id, x.name, shownState(x)]),
    ),
  );
  const roster = useChat((s) => s.roster);
  const rooms = arranged(
    useDesk((s) => s.rooms),
    useRoomOrder((s) => s.order),
  );
  const boards = arrangedBoards(
    useBoard((s) => s.boards),
    useBoardOrder((s) => s.order),
  );
  const groups = useLayout().groups;
  // Selected as they're kept (a list made in the selector would be new on
  // every read, which zustand takes for a change).
  const order = useGrids((s) => s.order);
  const all = useGrids((s) => s.grids);
  const grids = order.flatMap((id) => all[id] ?? []);
  const role = useGrids((s) => s.role);
  const keys = useSettings((s) => s.keys.newTerminal);
  // Sessions by the names given them, as the sidebar shows them.
  const names = useSessionNames();
  const shown = JSON.parse(listed) as [string, string, SessionState][];
  const put = (content: PaneContent) => replacePane(gridId, pane.id, content);
  // A pane showing a terminal takes the keys it takes there.
  const inShell = pane.content?.kind === "terminal" || pane.content?.kind === "session";
  const replace: MenuEntry[] = [
    { kind: "item", label: "New terminal", kbd: shortcutLabel(inShell ? terminalKeys(keys) : keys), onSelect: () => (pane.content ? put({ kind: "terminal", terminalId: null }) : newTerminal(gridId)) },
    ...(shown.length ? [{ kind: "separator" as const }] : []),
    ...shown.map(([id, name, state]): MenuEntry => ({ kind: "item", label: names[id] ?? name, kbd: STATE_LABEL[state], onSelect: () => put({ kind: "session", sessionId: id }) })),
    ...(roster.length ? [{ kind: "separator" as const }] : []),
    ...roster.slice(0, 12).map((a): MenuEntry => ({ kind: "item", label: a.name, onSelect: () => put({ kind: "agent", agent: agentKey(a) }) })),
    { kind: "separator" },
    ...(rooms.length ? [{ kind: "item" as const, label: "Room", submenu: rooms.map((r): MenuEntry => ({ kind: "item", label: r.name, onSelect: () => put(roomContent(r.id)) })) }] : []),
    ...(boards.length ? [{ kind: "item" as const, label: "Board", submenu: boards.map((b): MenuEntry => ({ kind: "item", label: b.name, onSelect: () => put(boardContent(b.id)) })) }] : []),
    {
      kind: "item",
      label: "Floor",
      submenu: [
        { kind: "item", label: "Everything", onSelect: () => put(floorContent()) },
        ...groups.map((g): MenuEntry => ({ kind: "item", label: g.name, onSelect: () => put(floorContent(g.id)) })),
      ],
    },
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
              setSectionOpen("grids", true);
            },
          },
        ]
      : []),
  ];
  const agent = pane.content?.kind === "agent" ? pane.content.agent : null;
  // A board's filter: in its header's chips too, while the header is wide enough.
  const boardFilter = usePaneFilter(gridId, pane.id);
  const show: MenuEntry[] =
    pane.content?.kind === "board"
      ? [
          {
            kind: "item",
            label: "Show",
            submenu: FILTERS.map((f): MenuEntry => ({ kind: "item", label: f.label, checked: boardFilter === f.id, onSelect: () => setPaneFilter(gridId, pane.id, f.id) })),
          },
        ]
      : [];
  // A tracked terminal shows as its session, and back: the same terminal
  // either way, so nothing starts or stops.
  const tracked = useDesk((s) => (pane.content?.kind === "terminal" ? trackedIn(s.sessions, terminalKeyIn(pane.content)) : null));
  const shows = sessionKeyIn(pane.content);
  const ranInId = useDesk((s) => (shows ? (s.sessions[shows]?.terminalId ?? null) : null));
  // The terminal it runs in, on its own engine.
  const ranIn = ranInId && shows ? keyOf(splitKey(shows).machine, ranInId) : null;
  const terminal = useTerminals((s) => (ranIn && s.byId[ranIn]?.live ? s.byId[ranIn] : undefined));
  // A pane of its own in another grid: one here would be a second.
  const terminalElsewhere = useGrids((s) => !!ranIn && s.order.some((g) => g !== gridId && !!findContent(s.grids[g]?.panes ?? [], terminalContent(ranIn))));
  const hosted = useGrids((s) => hostedBy(gridId, pane.id, s));
  const swap: MenuEntry[] = tracked
    ? [{ kind: "item", label: "Show as session", onSelect: () => put(sessionContent(sessionKey(tracked))) }]
    : terminal && ranIn && !terminalElsewhere
      ? [{ kind: "item", label: "Show the terminal", onSelect: () => put(terminalContent(ranIn, terminal.cwd)) }]
      : [];
  const host: MenuEntry[] = [
    { kind: "item", label: pane.content ? "Replace" : "Put here", submenu: replace },
    ...(pane.content && move.length ? [{ kind: "item" as const, label: "Move to grid", submenu: move }] : []),
    ...show,
    ...swap,
  ];
  const close: MenuEntry[] = [{ kind: "item", label: removeLabel(pane, hosted), onSelect: onClose }];
  return {
    host,
    close,
    entries: [...host, ...(agent && role.kind === "main" ? [{ kind: "item" as const, label: "Agent settings", onSelect: () => openAgentSettings(agent) }] : []), { kind: "separator" }, ...close],
  };
}
