import { useChat } from "../chat/store";
import { GridsSection } from "../grids/Grids";
import { SidebarGroups } from "../groups/SidebarGroups";
import { useDesk } from "../hub/store";
import { logoDot } from "../theme/builtin";
import { useTheme } from "../theme/store";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { VoicePill } from "../voice";
import { dragWindow } from "../ui/drag";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { useSavedScroll } from "../restore/scroll";

const VIEW_NAMES = { rooms: "Rooms", floor: "Floor", grids: "Grids" } as const;

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
  const hubs = useChat((s) => s.hubs);
  const theme = useTheme();
  const keys = useSettings((s) => s.keys);
  const scroller = useSavedScroll<HTMLElement>("sidebar");
  return (
    <nav ref={scroller} className="sidebar" aria-label="Desk">
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
      {view === "grids" ? (
        <GridsSection />
      ) : (
        <div className="side-section">
          <span className="side-label side-label-action">
            Rooms
            <button type="button" className="link small" onClick={onNewRoom}>
              New
            </button>
          </span>
          {rooms.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`side-row ${view === "rooms" && activeRoom === r.id ? "on" : ""}`}
              onClick={() => void openRoom(r.id)}
            >
              <span className="side-name">{r.name}</span>
              {(unread[r.id] ?? 0) > 0 && <span className="badge">{unread[r.id]}</span>}
            </button>
          ))}
        </div>
      )}
      <SidebarGroups onNewSession={onNewSession} newSessionKeys={shortcutLabel(keys.newSession)} onNewCrew={onNewCrew} />
      {view === "grids" && <p className="faint small side-hint">Drag a session or agent from here onto a pane. Hold ⇧ to drop it in the next free place.</p>}
      <div className="side-foot">
        <VoicePill />
        <span className="faint small">
          {connected ? hubs.map((h) => h.label).join(" · ") || "This Mac" : "Starting…"}
        </span>
        <ThemeSwitcher onSettings={onSettings} />
        <button type="button" className="link small side-settings" onClick={onSettings}>
          Settings <kbd>{shortcutLabel(keys.settings)}</kbd>
        </button>
      </div>
    </nav>
  );
}
