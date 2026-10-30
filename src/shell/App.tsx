import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import { Floor } from "../floor/Floor";
import { watchFloor } from "../floor/store";
import { GridsMain } from "../grids/Grids";
import { newTerminalHere, useGrids } from "../grids/store";
import { startGridsHere, useGridWindows } from "../grids/windows";
import { useDesk } from "../hub/store";
import { hubAccounts, hubConnection, inApp, onThemesChanged, subscribe } from "../platform";
import { useSettings } from "../settings/store";
import { useAppShortcut, useGlobalShortcut, useShortcuts } from "../shortcuts/manager";
import { useTuple } from "../tuple/useTuple";
import { useVoice } from "../voice";
import { useHubLinks } from "../hubs/follow";
import { prune } from "../rooms/engine";
import { NewCrew } from "../crew/NewCrew";
import { adoptDeskWelcome } from "../crew/welcome";
import { resumePairing } from "../hubs/PairHub";
import { NewRoom } from "../rooms/NewRoom";
import { Rooms } from "../rooms/Rooms";
import { ThreadPanel, useOpenThread } from "../rooms/RoomView";
import { AgentPanel, useAgentPanel } from "../rooms/AgentPanel";
import { Stage, type OpenPanel } from "../panels/Stage";
import { useSessionName } from "../groups/names";
import { useMainKey, useMainName } from "./mainName";
import { NewSession } from "../session/NewSession";
import { SessionCard } from "../session/SessionCard";
import { Settings } from "../settings/Settings";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { applyTheme, useTheme, useThemeStore } from "../theme/store";
import { loadCustomThemes } from "../theme/custom";
import { QuickAsk } from "./QuickAsk";
import { Sidebar } from "./Sidebar";
import { useUi } from "./ui";
import { dragWindow } from "../ui/drag";
import { useHost } from "./host";
import { resumeAfterUpdate } from "../updates/store";
import { UpdateNotice, useUpdateChecks } from "../updates/UpdateNotice";

/** How often the agents every workspace lists are read again. */
const ROSTER_EVERY_MS = 60_000;

export function App() {
  const { connect, sessions, openId, view, error, clearError, fail } = useDesk();
  const theme = useTheme();
  const { setCustom, setSystemDark } = useThemeStore();
  const [newSession, setNewSession] = useState(false);
  const [asking, setAsking] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [newCrew, setNewCrew] = useState(false);
  const rooms = useDesk((s) => s.rooms);
  const hubs = useChat((s) => s.hubs);
  useEffect(() => {
    prune(rooms, hubs);
  }, [rooms, hubs]);
  useHubLinks();
  const settings = useUi((u) => u.settings !== null);
  const platform = useHost((h) => h.platform);
  const { openSettings, closeSettings } = useUi.getState();
  const setHubs = useChat((s) => s.setHubs);
  const loadSettings = useSettings((s) => s.load);
  const tupleOn = useSettings((s) => s.tuple);
  useTuple(tupleOn);
  useVoice(useSettings((s) => s.voice));
  useUpdateChecks();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Workspaces add, remove and share agents without telling Desk, so their
  // agent lists are read again every minute and whenever Desk comes forward.
  useEffect(() => {
    const again = () => void useChat.getState().refreshRoster();
    const every = setInterval(again, ROSTER_EVERY_MS);
    window.addEventListener("focus", again);
    return () => {
      clearInterval(every);
      window.removeEventListener("focus", again);
    };
  }, []);

  useEffect(watchFloor, []);

  // Agents on this computer still greeting with the hub's WELCOME.md get Desk's.
  const desk = useDesk((s) => s.hub);
  const localIds = useChat((s) =>
    s.roster
      .filter((a) => s.hubs.some((h) => h.local && h.id === a.hubId))
      .map((a) => a.id)
      .sort()
      .join(" "),
  );
  useEffect(() => {
    if (desk && localIds) void adoptDeskWelcome(desk, localIds.split(" "));
  }, [desk, localIds]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [setSystemDark]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    const refresh = () => loadCustomThemes().then(setCustom).catch(fail);
    loadSettings().catch(fail);
    refresh();
    const unlisten = subscribe(onThemesChanged(refresh));
    hubConnection()
      .then((c) => (stop = connect(c)))
      .then(() => (inApp ? resumeAfterUpdate() : undefined))
      .then(() => hubAccounts())
      .then(setHubs)
      .then(resumePairing)
      .catch(fail);
    return () => {
      stop?.();
      unlisten();
    };
  }, [connect, fail, loadSettings, setCustom, setHubs]);

  useGlobalShortcut(
    "ask",
    useSettings((s) => (s.loaded ? s.keys.ask : null)),
    (e) => {
      if (e.state !== "Pressed") return;
      const w = getCurrentWindow();
      void w.show().then(() => w.setFocus());
      setAsking(true);
    },
  );
  const askStatus = useShortcuts((s) => s.status.ask);
  useEffect(() => {
    if (askStatus.state === "taken") fail(`${askStatus.message} in Settings → Shortcuts.`);
  }, [askStatus, fail]);

  // Grids: kept in step with the other windows, and each detached one's
  // window kept open on its monitor.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    void startGridsHere({ kind: "main" }).then((s) => (gone ? s() : (stop = s)));
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
  useGridWindows(useGrids((s) => s.ready));

  useAppShortcut("newSession", () => setNewSession(true));
  useAppShortcut("newTerminal", () => {
    useUi.getState().closeSettings();
    useDesk.getState().setView("grids");
    newTerminalHere();
  });
  useAppShortcut("settings", () => (useUi.getState().settings ? closeSettings() : openSettings()));

  const open = openId ? sessions[openId] : undefined;
  const sessionName = useSessionName(open?.id, open?.name ?? "");
  const thread = useOpenThread();
  const beside = useAgentPanel();
  const mainName = useMainName();
  const mainKey = useMainKey();
  const panels: OpenPanel[] = [];
  if (thread) {
    panels.push({
      kind: "thread",
      label: "Thread",
      element: (
        <ErrorBoundary name="thread">
          <ThreadPanel key={`${thread.room.id}/${thread.thread}`} room={thread.room} thread={thread.thread} />
        </ErrorBoundary>
      ),
    });
  }
  if (beside) {
    panels.push({
      kind: "agent",
      label: beside.name,
      element: (
        <ErrorBoundary name="agent">
          <AgentPanel agent={beside} />
        </ErrorBoundary>
      ),
    });
  }
  if (open) {
    panels.push({
      kind: "session",
      label: sessionName,
      element: (
        <ErrorBoundary name="session">
          <SessionCard session={open} />
        </ErrorBoundary>
      ),
    });
  }
  return (
    <div className="app">
      {/* On macOS the window has no title bar (traffic lights overlay the
          content), so this strip is what moves it; elsewhere the system's
          title bar does. */}
      {platform === "macos" && <div className="titlebar" onMouseDown={dragWindow} />}
      {settings ? (
        <ErrorBoundary name="settings">
          <Settings onClose={closeSettings} />
        </ErrorBoundary>
      ) : (
        <>
          <ErrorBoundary name="sidebar">
            <Sidebar
              onAsk={() => setAsking(true)}
              onNewSession={() => setNewSession(true)}
              onNewRoom={() => setNewRoom(true)}
              onNewCrew={() => setNewCrew(true)}
              onSettings={() => openSettings()}
            />
          </ErrorBoundary>
          <Stage
            mainKey={mainKey}
            mainName={mainName}
            panels={panels}
            main={
              <ErrorBoundary name="main">
                {view === "floor" ? <Floor onNewSession={() => setNewSession(true)} /> : view === "grids" ? <GridsMain /> : <Rooms />}
              </ErrorBoundary>
            }
          />
        </>
      )}
      {newSession && <NewSession onClose={() => setNewSession(false)} />}
      {asking && <QuickAsk onClose={() => setAsking(false)} />}
      {newRoom && <NewRoom onClose={() => setNewRoom(false)} />}
      {newCrew && <NewCrew onClose={() => setNewCrew(false)} />}
      <UpdateNotice />
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" className="link" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
