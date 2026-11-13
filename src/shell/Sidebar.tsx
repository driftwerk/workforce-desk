import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { SideResize } from "./SideResize";
import { useSideFoot, useSideWidth } from "./sideWidth";
import { useChat } from "../chat/store";
import { workspaces } from "../chat/types";
import { GridsSection } from "../grids/Grids";
import { roomContent } from "../grids/engine";
import { InGridRow, openFromRow, putInGrid } from "../grids/putIn";
import { roomItem } from "../grids/where";
import { SortList, SortRow } from "../groups/rows";
import { arranged, moveRoom, nudgeRoom, useRoomOrder } from "../rooms/order";
import { DeleteRoom } from "../rooms/DeleteRoom";
import { markRoomRead } from "../unread/reads";
import { NOTIFY_LEVELS, levelOf, setLevel } from "../unread/prefs";
import { SidebarGroups } from "../groups/SidebarGroups";
import { useDesk } from "../hub/store";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { VoicePill } from "../voice";
import { dragWindow } from "../ui/drag";
import { Menu } from "../ui/Menu";
import { YouMark } from "../ui/Mark";
import { useYou } from "../pictures/who";
import { useUi } from "./ui";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { RoomMarks } from "../unread/RoomMarks";
import { Marks, useRoomsBadge, useTotal } from "../unread/Marks";
import { BoardsSection } from "../board/BoardsSection";
import { setSectionOpen, SideSection } from "./SideSection";
import { Badge, needsYou } from "../ui/Badge";
import { useNeeds } from "../floor/store";
import { useSavedScroll } from "../restore/scroll";
import { NEW_CREW_LINE, NEW_SESSION_LINE } from "./newLines";

/** The Unread page's row: everything new for you, each item once; with
 *  nothing to show it goes, but while the page is open. */
function UnreadRow() {
  const on = useDesk((s) => s.view === "rooms" && s.inbox);
  const setInbox = useDesk((s) => s.setInbox);
  const keys = useSettings((s) => s.keys);
  const total = useTotal();
  if (!total.count && !total.dot && !on) return null;
  return (
    <button
      type="button"
      className={`side-unread${on ? " on" : ""}`}
      aria-current={on ? "true" : undefined}
      title={`Unread (${shortcutLabel(keys.unread)})${total.count ? `: ${needsYou(total.count)}` : total.dot ? ": something new" : ""}`}
      onClick={() => setInbox(true)}
    >
      <span className="gi-name">Unread</span>
      <Marks badge={total} />
    </button>
  );
}

/** The Dashboard's row: it opens the Dashboard, and counts what waits on
 *  you there. */
function DashboardRow() {
  const on = useDesk((s) => s.view === "floor" && !s.inbox);
  return (
    <button
      type="button"
      className={`side-dash${on ? " on" : ""}`}
      aria-current={on ? "page" : undefined}
      onClick={() => {
        useUi.getState().closeSettings();
        useDesk.getState().setView("floor");
      }}
    >
      <DashIcon />
      <span className="gi-name">Dashboard</span>
      <DashboardCount />
    </button>
  );
}

/** What waits on you, as the Floor counts it: on its own, as reading it
 *  reads every hub's floor. */
function DashboardCount() {
  const n = useNeeds().length;
  return n > 0 ? <Badge count={n} says={needsYou(n)} tone="needs" /> : null;
}

/** Whether a scroller has more above and below what shows. */
export const scrollEdges = (el: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">): { above: boolean; below: boolean } => ({
  above: el.scrollTop > 1,
  below: el.scrollHeight - el.clientHeight - el.scrollTop > 1,
});

/** A ref for a scroller that says (as `data-more-above` / `data-more-below`
 *  on it) whether there's more in each direction, as it scrolls, resizes or
 *  its content changes. */
function useScrollEdges(): (el: HTMLElement | null) => void {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return useCallback((el: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    const update = () => {
      const { above, below } = scrollEdges(el);
      el.toggleAttribute("data-more-above", above);
      el.toggleAttribute("data-more-below", below);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const resized = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    resized?.observe(el);
    const changed = typeof MutationObserver === "function" ? new MutationObserver(update) : null;
    changed?.observe(el, { childList: true, subtree: true });
    cleanup.current = () => {
      el.removeEventListener("scroll", update);
      resized?.disconnect();
      changed?.disconnect();
    };
  }, []);
}

/** You, as Desk shows you: opens your Profile. */
function You() {
  const { name } = useYou(null);
  if (!name) return null;
  return (
    <button type="button" className="side-you" title="Your picture, in Settings → Profile" onClick={() => useUi.getState().openSettings("profile")}>
      <YouMark hub={null} size="sm" />
      <span className="side-you-name">{name}</span>
    </button>
  );
}

/** The sidebar: Ask anyone and the views always at the top; the rooms or
 *  grids and the groups scrolling between; new session, new crew member,
 *  Settings, voice and the look always at the bottom. */
export function Sidebar({
  onAsk,
  onNewSession,
  onNewRoom,
  onNewCrew,
  onSettings,
}: {
  onAsk: () => void;
  /** From a group's menu, with the group it starts in. */
  onNewSession: (group?: string) => void;
  onNewRoom: () => void;
  onNewCrew: () => void;
  onSettings: () => void;
}) {
  const { view, connected, activeRoom, openRoom } = useDesk(
    useShallow((s) => ({ view: s.view, connected: s.connected, activeRoom: s.activeRoom, openRoom: s.openRoom })),
  );
  const roomOrder = useRoomOrder((s) => s.order);
  const rooms = arranged(useDesk((s) => s.rooms), roomOrder);
  const [roomMenu, setRoomMenu] = useState<{ id: string; at: { x: number; y: number }; from: HTMLElement | null } | null>(null);
  const [deletingRoom, setDeletingRoom] = useState<string | null>(null);
  const roomsById = useDesk((s) => s.rooms);
  const roomsBadge = useRoomsBadge(rooms.map((r) => r.id));
  // A room opened elsewhere opens Rooms, so its row shows; once each time,
  // so it can be closed again.
  const roomBefore = useRef(activeRoom);
  useEffect(() => {
    if (activeRoom === roomBefore.current) return;
    roomBefore.current = activeRoom;
    if (activeRoom) setSectionOpen("rooms", true);
  }, [activeRoom]);
  /** Deletes a room on the hub, and here at once (the hub says so too).
   *  Its members' hubs are told first, so what was set up there reaches
   *  your DM instead. */
  const [roomSaid, setRoomSaid] = useState("");
  const roomRows = useRef(new Map<string, HTMLElement>());
  const roomDragged = useRef(false);
  const roomHint = useId();
  const sayRoom = (id: string) => {
    const ids = arranged(useDesk.getState().rooms, useRoomOrder.getState().order).map((r) => r.id);
    setRoomSaid(`${useDesk.getState().rooms[id]?.name}: room ${ids.indexOf(id) + 1} of ${ids.length}`);
  };
  const nudgeRoomBy = (id: string, by: -1 | 1) => {
    if (!nudgeRoom(id, by)) return setRoomSaid(by < 0 ? "Already the first room" : "Already the last room");
    sayRoom(id);
    requestAnimationFrame(() => roomRows.current.get(id)?.focus());
  };
  const hubs = useChat((s) => workspaces(s.hubs));
  const keys = useSettings((s) => s.keys);
  const sideWidth = useSideWidth((s) => s.width);
  const footOpen = useSideFoot((s) => s.open);
  const setFootOpen = useSideFoot.getState().setOpen;
  const voiceOn = useSettings((s) => s.voice);
  const setSettings = useSettings((s) => s.set);
  // Where it was scrolled is kept (in `ui.main`) and put back.
  const saved = useSavedScroll<HTMLElement>("sidebar");
  const edges = useScrollEdges();
  const middle = useCallback(
    (el: HTMLDivElement | null) => {
      saved(el);
      edges(el);
    },
    [saved, edges],
  );
  return (
    <nav className="sidebar" aria-label="Desk" style={{ "--side-w": `${sideWidth}px` } as React.CSSProperties}>
      <SideResize />
      <div className="side-top">
        <div className="wordmark" onMouseDown={dragWindow}>
          <span>desk</span>
          <span className="wordmark-dot" />
        </div>
        <button type="button" className="ask" onClick={onAsk}>
          Ask anyone <kbd>{shortcutLabel(keys.ask)}</kbd>
        </button>
        <DashboardRow />
        <UnreadRow />
      </div>
      <div className="side-mid">
        <div ref={middle} className="side-scroll">
          <GridsSection />
          <SideSection id="rooms" label="Rooms" newLabel="New room" onNew={onNewRoom} badge={roomsBadge}>
            <span id={roomHint} className="sr-only">
              Alt+Up and Alt+Down move it. Shift+F10 opens its menu.
            </span>
            <SortList
              label="Rooms"
              type="room"
              ids={rooms.map((r) => r.id)}
              chip={(id) => roomsById[id]?.name}
              toGrid={(id) => (roomsById[id] ? { content: roomContent(id), name: roomsById[id]!.name } : null)}
              onDragStart={() => setRoomMenu(null)}
              justDragged={roomDragged}
              onMove={(id, before) => {
                moveRoom(id, before);
                sayRoom(id);
              }}
              row={(id, lineBefore) => {
                const r = roomsById[id]!;
                return (
                  <InGridRow
                    key={id}
                    item={roomItem(id)}
                    row={(mark, markId) => (
                      <SortRow
                        id={id}
                        type="room"
                        lineBefore={lineBefore}
                        on={view === "rooms" && activeRoom === id}
                        name={r.name}
                        title={view === "grids" ? "Drag onto a pane, or to reorder" : "Drag to reorder"}
                        describedBy={markId ? `${roomHint} ${markId}` : roomHint}
                        more={`${r.name} options`}
                        register={(el) => (el ? roomRows.current.set(id, el) : roomRows.current.delete(id))}
                        onOpen={() => !roomDragged.current && openFromRow(roomContent(id), () => void openRoom(id))}
                        onNudge={(by) => nudgeRoomBy(id, by)}
                        onMenu={(at, from) => setRoomMenu({ id, at, from })}
                      >
                        {mark}
                        <RoomMarks room={r} />
                      </SortRow>
                    )}
                  />
                );
              }}
            />
            <span className="sr-only" aria-live="polite">
              {roomSaid}
            </span>
            {roomMenu && roomsById[roomMenu.id] && (
              <Menu
                label={`${roomsById[roomMenu.id]!.name} options`}
                at={roomMenu.at}
                entries={[
                  { kind: "item", label: "Open", onSelect: () => void openRoom(roomMenu.id) },
                  putInGrid(roomContent(roomMenu.id)),
                  { kind: "separator" },
                  { kind: "item", label: "Details…", onSelect: () => useUi.getState().setRoomDetails({ room: roomMenu.id, rename: false }) },
                  { kind: "item", label: "Rename…", onSelect: () => useUi.getState().setRoomDetails({ room: roomMenu.id, rename: true }) },
                  { kind: "item", label: "Mark all read", onSelect: () => void markRoomRead(roomMenu.id).catch(useDesk.getState().fail) },
                  {
                    kind: "item",
                    label: "Notifications",
                    submenu: NOTIFY_LEVELS.map((l) => ({
                      kind: "item" as const,
                      label: `${levelOf({ kind: "room", room: roomMenu.id }) === l.id ? "✓ " : ""}${l.label}`,
                      onSelect: () => setLevel({ kind: "room", room: roomMenu.id }, l.id),
                    })),
                  },
                  { kind: "separator" },
                  { kind: "item", label: "Delete room…", onSelect: () => setDeletingRoom(roomMenu.id) },
                ]}
                onClose={(refocus) => {
                  if (refocus) roomMenu.from?.focus();
                  setRoomMenu(null);
                }}
              />
            )}
          </SideSection>
          {deletingRoom && roomsById[deletingRoom] && <DeleteRoom room={roomsById[deletingRoom]!} onClose={() => setDeletingRoom(null)} />}
          <BoardsSection />
          <SidebarGroups onNewSession={onNewSession} />
          {view === "grids" && (
            <p className="faint small side-hint">Drag a room, board, session or agent from here onto a pane. Hold ⇧ to drop it in the next free place.</p>
          )}
        </div>
        <span className="side-fade side-fade-top" aria-hidden="true" />
        <span className="side-fade side-fade-bottom" aria-hidden="true" />
      </div>
      <div className="side-foot" data-open={footOpen || undefined}>
        {!footOpen && (
          <div className="side-mini" role="toolbar" aria-label="Quick actions">
            <button type="button" className="icon-btn side-mini-btn" onClick={() => onNewSession()} aria-label="New session" title={`New session (${shortcutLabel(keys.newSession)})`}>
              <PlusIcon />
            </button>
            <button type="button" className="icon-btn side-mini-btn" onClick={onNewCrew} aria-label="New crew member" title="New crew member">
              <CrewIcon />
            </button>
            <button type="button" className="icon-btn side-mini-btn" onClick={onSettings} aria-label="Settings" title={`Settings (${shortcutLabel(keys.settings)})`}>
              <GearIcon />
            </button>
            <button
              type="button"
              className={`icon-btn side-mini-btn${voiceOn ? " on" : ""}`}
              aria-pressed={voiceOn}
              aria-label={voiceOn ? "Turn voice off" : "Turn voice on"}
              title={`${voiceOn ? "Turn voice off" : "Turn voice on"} (hold ${shortcutLabel(keys.pushToTalk)} to talk)`}
              onClick={() => setSettings({ voice: !voiceOn })}
            >
              <MicIcon />
            </button>
            <button type="button" className="icon-btn side-mini-btn side-foot-toggle" aria-expanded={false} aria-label="Show more" title="Show New session, Settings, voice and themes" onClick={() => setFootOpen(true)}>
              <Chevron open={false} />
            </button>
          </div>
        )}
        {footOpen && (
          <button type="button" className="icon-btn side-mini-btn side-foot-toggle side-foot-fold" aria-expanded aria-label="Show less" title="Fold these into a row of icons" onClick={() => setFootOpen(false)}>
            <Chevron open />
          </button>
        )}
        {footOpen && (
          <>

        <div className="side-actions">
          <button type="button" className="btn side-btn" onClick={() => onNewSession()} aria-label="New session" title={NEW_SESSION_LINE}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M7 2v10M2 7h10" />
            </svg>
            <span className="side-btn-label">New session</span> <kbd>{shortcutLabel(keys.newSession)}</kbd>
          </button>
          <button type="button" className="btn side-btn" onClick={onNewCrew} title={NEW_CREW_LINE}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <circle cx="5.5" cy="4.5" r="2.5" />
              <path d="M1 12.5c.4-2.4 2.2-3.8 4.5-3.8s4.1 1.4 4.5 3.8M11 4v4M9 6h4" />
            </svg>
            <span className="side-btn-label">New crew member</span>
          </button>
          <button type="button" className="btn side-btn" onClick={onSettings}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <circle cx="7" cy="7" r="2" />
              <path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.8 2.8l1.4 1.4M9.8 9.8l1.4 1.4M2.8 11.2l1.4-1.4M9.8 4.2l1.4-1.4" />
            </svg>
            <span className="side-btn-label">Settings</span> <kbd>{shortcutLabel(keys.settings)}</kbd>
          </button>
        </div>
        <VoicePill />
        <You />
        <span className="faint small side-hubs">{connected ? hubs.map((h) => h.label).join(" · ") || "This computer" : "Starting…"}</span>
        <ThemeSwitcher onSettings={onSettings} />
          </>
        )}
      </div>
    </nav>
  );
}

const icon = { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", stroke: "currentColor", strokeWidth: 1.7, "aria-hidden": true } as const;
const PlusIcon = () => (
  <svg {...icon}>
    <path d="M7 2v10M2 7h10" />
  </svg>
);
const CrewIcon = () => (
  <svg {...icon}>
    <circle cx="5.5" cy="4.5" r="2.5" />
    <path d="M1 12.5c.4-2.4 2.2-3.8 4.5-3.8s4.1 1.4 4.5 3.8M11 4v4M9 6h4" />
  </svg>
);
const GearIcon = () => (
  <svg {...icon}>
    <circle cx="7" cy="7" r="2" />
    <path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.8 2.8l1.4 1.4M9.8 9.8l1.4 1.4M2.8 11.2l1.4-1.4M9.8 4.2l1.4-1.4" />
  </svg>
);
const MicIcon = () => (
  <svg {...icon}>
    <rect x="5" y="1.5" width="4" height="7" rx="2" />
    <path d="M2.5 7a4.5 4.5 0 0 0 9 0M7 11.5V13" />
  </svg>
);
const DashIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="side-dash-icon">
    <rect x="2" y="2" width="5" height="6" rx="1.2" />
    <rect x="9" y="2" width="5" height="3.5" rx="1.2" />
    <rect x="9" y="7.5" width="5" height="6.5" rx="1.2" />
    <rect x="2" y="10" width="5" height="4" rx="1.2" />
  </svg>
);
const Chevron = ({ open }: { open: boolean }) => (
  <svg {...icon} style={{ transform: open ? "none" : "rotate(180deg)" }}>
    <path d="M3 5l4 4 4-4" />
  </svg>
);
