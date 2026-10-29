import { useChat } from "../chat/store";
import { SidebarGroups } from "../groups/SidebarGroups";
import { useDesk } from "../hub/store";
import { logoDot } from "../theme/builtin";
import { useTheme } from "../theme/store";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { VoicePill } from "../voice";
import { dragWindow } from "../ui/drag";
import { ThemeSwitcher } from "./ThemeSwitcher";

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
  return (
    <nav className="sidebar" aria-label="Desk">
      <div className="wordmark" onMouseDown={dragWindow}>
        <span>desk</span>
        <span className="wordmark-dot" style={{ background: logoDot(theme.spec) }} />
      </div>
      <button type="button" className="ask" onClick={onAsk}>
        Ask anyone <kbd>{shortcutLabel(keys.ask)}</kbd>
      </button>
      <div className="tabs" role="tablist" aria-label="View">
        {(["rooms", "floor"] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}>
            {v === "floor" ? "Floor" : "Rooms"}
          </button>
        ))}
      </div>
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
      <SidebarGroups onNewSession={onNewSession} newSessionKeys={shortcutLabel(keys.newSession)} onNewCrew={onNewCrew} />
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
