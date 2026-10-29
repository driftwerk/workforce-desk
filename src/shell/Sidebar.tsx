import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { GridsSection, MoreIcon } from "../grids/Grids";
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
  const rooms = Object.values(useDesk((s) => s.rooms)).sort((a, b) => a.name.localeCompare(b.name));
  const [roomMenu, setRoomMenu] = useState<{ id: string; at: { x: number; y: number }; from: HTMLElement | null } | null>(null);
  const [deletingRoom, setDeletingRoom] = useState<string | null>(null);
  const roomsById = useDesk((s) => s.rooms);
  /** Deletes a room on the hub, and here at once (the hub says so too). */
  const deleteRoom = async (id: string) => {
    const { hub } = useDesk.getState();
    if (!hub) throw new Error("Desk isn't connected to its hub.");
    await hub.deleteRoom(id);
    useDesk.setState((s) => {
      const { [id]: _gone, ...rest } = s.rooms;
      return { rooms: rest, activeRoom: s.activeRoom === id ? null : s.activeRoom };
    });
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
              {rooms.map((r) => (
                <div key={r.id} className="side-item">
                  <button
                    type="button"
                    className={`side-row ${view === "rooms" && activeRoom === r.id ? "on" : ""}`}
                    onClick={() => void openRoom(r.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setRoomMenu({ id: r.id, at: { x: e.clientX, y: e.clientY }, from: e.currentTarget });
                    }}
                  >
                    <span className="side-name">{r.name}</span>
                    {(unread[r.id] ?? 0) > 0 && <span className="badge">{unread[r.id]}</span>}
                  </button>
                  <button
                    type="button"
                    className="icon-btn-sm side-more"
                    aria-label={`${r.name} options`}
                    aria-haspopup="menu"
                    onClick={(e) => {
                      const b = e.currentTarget.getBoundingClientRect();
                      setRoomMenu({ id: r.id, at: { x: b.left, y: b.bottom + 2 }, from: e.currentTarget });
                    }}
                  >
                    <MoreIcon />
                  </button>
                </div>
              ))}
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
        <span className="faint small side-hubs">{connected ? hubs.map((h) => h.label).join(" · ") || "This Mac" : "Starting…"}</span>
        <ThemeSwitcher onSettings={onSettings} />
      </div>
    </nav>
  );
}
