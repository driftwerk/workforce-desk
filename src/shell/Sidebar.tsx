import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { GridsSection } from "../grids/Grids";
import { SortList, SortRow } from "../groups/rows";
import { arranged, forgetRoom, moveRoom, nudgeRoom, useRoomOrder } from "../rooms/order";
import { closeRoom } from "../rooms/engine";
import { SidebarGroups } from "../groups/SidebarGroups";
import { useDesk } from "../hub/store";
import { logoDot } from "../theme/builtin";
import { useTheme } from "../theme/store";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { VoicePill } from "../voice";
import { dragWindow } from "../ui/drag";
import { Confirm } from "../ui/Confirm";
import { Menu } from "../ui/Menu";
import { YouMark } from "../ui/Mark";
import { useYou } from "../pictures/who";
import { useUi } from "./ui";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { useSavedScroll } from "../restore/scroll";

const VIEW_NAMES = { rooms: "Rooms", floor: "Floor", grids: "Grids" } as const;

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
  onNewSession: () => void;
  onNewRoom: () => void;
  onNewCrew: () => void;
  onSettings: () => void;
}) {
  const { view, setView, connected, activeRoom, openRoom, unread } = useDesk();
  const roomOrder = useRoomOrder((s) => s.order);
  const rooms = arranged(useDesk((s) => s.rooms), roomOrder);
  const [roomMenu, setRoomMenu] = useState<{ id: string; at: { x: number; y: number }; from: HTMLElement | null } | null>(null);
  const [deletingRoom, setDeletingRoom] = useState<string | null>(null);
  const roomsById = useDesk((s) => s.rooms);
  /** Deletes a room on the hub, and here at once (the hub says so too).
   *  Its members' hubs are told first, so what was set up there reaches
   *  your DM instead. */
  const deleteRoom = async (id: string) => {
    const { hub, rooms } = useDesk.getState();
    if (!hub) throw new Error("Desk isn't connected to its hub.");
    const room = rooms[id];
    if (room) await closeRoom(room);
    await hub.deleteRoom(id);
    useDesk.setState((s) => {
      const { [id]: _gone, ...rest } = s.rooms;
      return { rooms: rest, activeRoom: s.activeRoom === id ? null : s.activeRoom };
    });
    forgetRoom(id);
  };
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
  const hubs = useChat((s) => s.hubs);
  const theme = useTheme();
  const keys = useSettings((s) => s.keys);
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
    <nav className="sidebar" aria-label="Desk">
      <div className="side-top">
        <div className="wordmark" onMouseDown={dragWindow}>
          <span>desk</span>
          <span className="wordmark-dot" style={{ background: logoDot(theme.spec) }} />
        </div>
        <button type="button" className="ask" onClick={onAsk}>
          Ask anyone <kbd>{shortcutLabel(keys.ask)}</kbd>
        </button>
        <div className="tabs" role="tablist" aria-label="View">
          {(["rooms", "floor", "grids"] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}>
              {VIEW_NAMES[v]}
            </button>
          ))}
        </div>
      </div>
      <div className="side-mid">
        <div ref={middle} className="side-scroll">
          {view === "grids" ? (
            <GridsSection />
          ) : (
            <div className="side-section" role="region" aria-label="Rooms">
              <span className="side-label side-label-action side-head">
                Rooms
                <button type="button" className="icon-btn-sm" aria-label="New room" title="New room" onClick={onNewRoom}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <path d="M7 2v10M2 7h10" />
                  </svg>
                </button>
              </span>
              <span id={roomHint} className="sr-only">
                Alt+Up and Alt+Down move it. Shift+F10 opens its menu.
              </span>
              <SortList
                label="Rooms"
                type="room"
                ids={rooms.map((r) => r.id)}
                chip={(id) => roomsById[id]?.name}
                onDragStart={() => setRoomMenu(null)}
                justDragged={roomDragged}
                onMove={(id, before) => {
                  moveRoom(id, before);
                  sayRoom(id);
                }}
                row={(id, lineBefore) => {
                  const r = roomsById[id]!;
                  return (
                    <SortRow
                      key={id}
                      id={id}
                      type="room"
                      lineBefore={lineBefore}
                      on={view === "rooms" && activeRoom === id}
                      name={r.name}
                      title="Drag to reorder"
                      describedBy={roomHint}
                      more={`${r.name} options`}
                      register={(el) => (el ? roomRows.current.set(id, el) : roomRows.current.delete(id))}
                      onOpen={() => !roomDragged.current && void openRoom(id)}
                      onNudge={(by) => nudgeRoomBy(id, by)}
                      onMenu={(at, from) => setRoomMenu({ id, at, from })}
                    >
                      {(unread[id] ?? 0) > 0 && <span className="badge">{unread[id]}</span>}
                    </SortRow>
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
                  entries={[{ kind: "item", label: "Delete room…", onSelect: () => setDeletingRoom(roomMenu.id) }]}
                  onClose={(refocus) => {
                    if (refocus) roomMenu.from?.focus();
                    setRoomMenu(null);
                  }}
                />
              )}
              {deletingRoom && roomsById[deletingRoom] && (
                <Confirm
                  title={`Delete “${roomsById[deletingRoom]!.name}”?`}
                  action="Delete room"
                  onConfirm={() => deleteRoom(deletingRoom)}
                  onClose={() => setDeletingRoom(null)}
                >
                  <p className="muted">Its messages are deleted for everyone in it. The agents in it stay in your crew.</p>
                </Confirm>
              )}
            </div>
          )}
          <SidebarGroups />
          {view === "grids" && <p className="faint small side-hint">Drag a session or agent from here onto a pane. Hold ⇧ to drop it in the next free place.</p>}
        </div>
        <span className="side-fade side-fade-top" aria-hidden="true" />
        <span className="side-fade side-fade-bottom" aria-hidden="true" />
      </div>
      <div className="side-foot">
        <div className="side-actions">
          <button type="button" className="btn side-btn" onClick={onNewSession} aria-label="New session">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M7 2v10M2 7h10" />
            </svg>
            <span className="side-btn-label">New session</span> <kbd>{shortcutLabel(keys.newSession)}</kbd>
          </button>
          <button type="button" className="btn side-btn" onClick={onNewCrew}>
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
        <span className="faint small side-hubs">{connected ? hubs.map((h) => h.label).join(" · ") || "This Mac" : "Starting…"}</span>
        <ThemeSwitcher onSettings={onSettings} />
      </div>
    </nav>
  );
}
