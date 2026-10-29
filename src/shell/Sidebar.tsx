import { useChat } from "../chat/store";
import { agentKey, describeAgent } from "../chat/types";
import { sortedSessions, useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { logoDot } from "../theme/builtin";
import { useTheme } from "../theme/store";
import { useOverview } from "../overview/store";
import { Mark } from "../ui/Mark";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { VoicePill } from "../voice";
import { dragWindow } from "../ui/drag";
import { ThemeSwitcher } from "./ThemeSwitcher";

const STATE_LABEL: Partial<Record<Session["state"], string>> = {
  working: "working",
  starting: "starting",
  blocked: "needs you",
  done: "done",
  interrupted: "interrupted",
};

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
  const { sessions, openId, open, view, setView, connected, activeRoom, openRoom, unread } = useDesk();
  const rooms = Object.values(useDesk((s) => s.rooms)).sort((a, b) => a.name.localeCompare(b.name));
  const { roster, hubs, activeAgent, openDm } = useChat();
  const theme = useTheme();
  const list = sortedSessions(sessions).filter((s) => s.state !== "closed");
  const hubLabel = (id: string) => hubs.find((h) => h.id === id)?.label ?? id;
  const keys = useSettings((s) => s.keys);
  const managerId = useOverview((s) => s.manager?.agentId ?? null);
  const overseer = (a: (typeof roster)[number]) => a.id === managerId && !!hubs.find((h) => h.id === a.hubId)?.local;
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
      <div className="side-section">
        <span className="side-label side-label-action">
          Crew
          <button type="button" className="link small" onClick={onNewCrew}>
            New
          </button>
        </span>
        {roster.map((a) => (
          <button
            key={agentKey(a)}
            type="button"
            className={`side-row crew-row ${view === "rooms" && !activeRoom && activeAgent === agentKey(a) ? "on" : ""}`}
            title={describeAgent(a, hubLabel(a.hubId))}
            onClick={() => {
              void openRoom(null);
              openDm(agentKey(a));
            }}
          >
            <Mark name={a.name} size="sm" />
            {overseer(a) ? (
              <span className="crew-name crew-name-stack">
                <span className="display">{a.name}</span>
                <span className="faint small">Overseeing the crew</span>
              </span>
            ) : (
              <>
                <span className="display crew-name">{a.name}</span>
                <span className="faint small">{hubLabel(a.hubId)}</span>
              </>
            )}
          </button>
        ))}
      </div>
      <div className="side-section">
        <span className="side-label side-label-action">
          Sessions
          <button type="button" className="link small" onClick={onNewSession} aria-label="New session">
            New {shortcutLabel(keys.newSession)}
          </button>
        </span>
        {list.map((s) => (
          <button key={s.id} type="button" className={`side-row ${openId === s.id ? "on" : ""}`} onClick={() => open(s.id)}>
            <span className={`dot dot-${s.state}`} />
            <span className="mono side-name">{s.name}</span>
            <span className={`small state-${s.state}`}>{STATE_LABEL[s.state] ?? ""}</span>
          </button>
        ))}
      </div>
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
