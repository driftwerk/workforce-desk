import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import { Floor } from "../floor/Floor";
import { useDesk } from "../hub/store";
import { hubAccounts, hubConnection, inApp, onThemesChanged, subscribe, themeFiles } from "../platform";
import { useSettings } from "../settings/store";
import { useAppShortcut, useGlobalShortcut, useShortcuts } from "../shortcuts/manager";
import { useTuple } from "../tuple/useTuple";
import { useVoice } from "../voice";
import { prune } from "../rooms/engine";
import { NewCrew } from "../crew/NewCrew";
import { NewRoom } from "../rooms/NewRoom";
import { Rooms } from "../rooms/Rooms";
import { NewSession } from "../session/NewSession";
import { SessionCard } from "../session/SessionCard";
import { Settings } from "../settings/Settings";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { applyTheme, useTheme, useThemeStore } from "../theme/store";
import { parseTheme, ThemeError } from "../theme/toml";
import type { ThemeSpec } from "../theme/tokens";
import { QuickAsk } from "./QuickAsk";
import { Sidebar } from "./Sidebar";
import { dragWindow } from "../ui/drag";
import { resumeAfterUpdate } from "../updates/store";
import { UpdateNotice, useUpdateChecks } from "../updates/UpdateNotice";

const loadCustomThemes = async (): Promise<ThemeSpec[]> =>
  (await themeFiles()).flatMap((f) => {
    try {
      return [parseTheme(f.id, f.source)];
    } catch (e) {
      if (e instanceof ThemeError) console.warn(`theme ${f.id}.toml: ${e.message}`);
      return [];
    }
  });

export function App() {
  const { connect, sessions, openId, view, error, clearError, fail } = useDesk();
  const theme = useTheme();
  const { setCustom, setSystemDark } = useThemeStore();
  const [newSession, setNewSession] = useState(false);
  const [asking, setAsking] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [newCrew, setNewCrew] = useState(false);
  const rooms = useDesk((s) => s.rooms);
  useEffect(() => {
    prune(rooms);
  }, [rooms]);
  const [settings, setSettings] = useState(false);
  const setHubs = useChat((s) => s.setHubs);
  const loadSettings = useSettings((s) => s.load);
  const tupleOn = useSettings((s) => s.tuple);
  useTuple(tupleOn);
  useVoice(useSettings((s) => s.voice));
  useUpdateChecks();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

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

  useAppShortcut("newSession", () => setNewSession(true));
  useAppShortcut("settings", () => setSettings((s) => !s));

  const open = openId ? sessions[openId] : undefined;
  return (
    <div className="app">
      {/* The window has no title bar (traffic lights overlay the content), so
          this strip is what moves it. */}
      <div className="titlebar" onMouseDown={dragWindow} />
      {settings ? (
        <ErrorBoundary name="settings">
          <Settings onClose={() => setSettings(false)} />
        </ErrorBoundary>
      ) : (
        <>
          <ErrorBoundary name="sidebar">
            <Sidebar
              onAsk={() => setAsking(true)}
              onNewSession={() => setNewSession(true)}
              onNewRoom={() => setNewRoom(true)}
              onNewCrew={() => setNewCrew(true)}
              onSettings={() => setSettings(true)}
            />
          </ErrorBoundary>
          <ErrorBoundary name="main">{view === "floor" ? <Floor onNewSession={() => setNewSession(true)} /> : <Rooms />}</ErrorBoundary>
          {open && (
            <ErrorBoundary name="session">
              <SessionCard session={open} />
            </ErrorBoundary>
          )}
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
