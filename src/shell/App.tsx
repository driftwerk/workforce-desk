import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import { Floor } from "../floor/Floor";
import { useDesk } from "../hub/store";
import { hubAccounts, hubConnection, inApp, onThemesChanged, themeFiles } from "../platform";
import { useSettings } from "../settings/store";
import { useTuple } from "../tuple/useTuple";
import { useVoice } from "../voice";
import { prune } from "../rooms/engine";
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
    let unlisten: (() => void) | undefined;
    const refresh = () => loadCustomThemes().then(setCustom).catch(fail);
    loadSettings().catch(fail);
    refresh();
    onThemesChanged(refresh).then((u) => (unlisten = u));
    hubConnection()
      .then((c) => (stop = connect(c)))
      .then(() => hubAccounts())
      .then(setHubs)
      .catch(fail);
    return () => {
      stop?.();
      unlisten?.();
    };
  }, [connect, fail, loadSettings, setCustom, setHubs]);

  useEffect(() => {
    if (!inApp) return;
    const shortcut = "Alt+Space";
    register(shortcut, (e) => {
      if (e.state !== "Pressed") return;
      const w = getCurrentWindow();
      void w.show().then(() => w.setFocus());
      setAsking(true);
    }).catch(fail);
    return () => void unregister(shortcut);
  }, [fail]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "n") {
        e.preventDefault();
        setNewSession(true);
      }
      if (e.metaKey && e.key === ",") {
        e.preventDefault();
        setSettings((s) => !s);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
              onSettings={() => setSettings(true)}
            />
          </ErrorBoundary>
          <ErrorBoundary name="main">{view === "floor" ? <Floor /> : <Rooms />}</ErrorBoundary>
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
