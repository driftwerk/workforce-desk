import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl as openExternal } from "@tauri-apps/plugin-opener";
import type { HubAccount } from "./chat/types";
import type { BrainChoice } from "./crew/brain";
import type { DeskGroup, Ungrouped } from "./groups/model";
import type { HubConnection } from "./hub/client";
import { preview } from "./preview";

/** False only in that browser preview: app-only features (global shortcuts,
 *  voice, Tuple) stay off there. */
export const inApp = !preview;

/** Tauri's invoke, or in a development browser preview the dev bridge. */
export const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  if (!preview) return tauriInvoke<T>(cmd, args);
  const { devInvoke } = await import("./devBridge");
  return devInvoke<T>(cmd, args);
};

export const listen = <T>(event: string, f: EventCallback<T>): Promise<UnlistenFn> =>
  preview ? Promise.resolve(() => {}) : tauriListen<T>(event, f);

/** A listener as an effect cleanup. `listen` resolves later, so a cleanup
 *  that runs first — React mounts effects twice in development — would
 *  otherwise leave the listener behind and every event would fire twice. */
export function subscribe(pending: Promise<UnlistenFn>): () => void {
  let gone = false;
  let unlisten: UnlistenFn | undefined;
  void pending.then((u) => (gone ? u() : (unlisten = u)));
  return () => {
    gone = true;
    unlisten?.();
  };
}

/** A voice from any provider: on-device Kokoro, Fish Audio, ElevenLabs,
 *  OpenAI, or a cloud conversation engine's own voices. */
export interface VoiceSpec {
  provider: string;
  model?: string;
  voice?: string;
}

/** A voice someone added by its id (a cloned or community voice), named as
 *  its provider calls it or as they chose. */
export interface CustomVoice {
  id: string;
  name: string;
  description?: string;
}

export interface Settings {
  theme: string;
  /** The sidebar chooser's theme, kept while Auto, Night or Day is on;
   *  older files have none (Harbour). */
  themePick?: string;
  tuple: boolean;
  /** How new agents think: a provider, and optionally a model and effort
   *  of it (its defaults otherwise); null for whichever plan is connected. */
  newAgent: BrainChoice | null;
  defaultVoice: VoiceSpec;
  /** Agents' own voices, by agent key. */
  agentVoices: Record<string, VoiceSpec>;
  /** Voices added by id, by provider (`fish_audio`, `elevenlabs`). */
  customVoices: Record<string, CustomVoice[]>;
  voice: boolean;
  /** "cascade" (on-device), "gpt-live" or "gemini-live". */
  voiceEngine: string;
  /** The keyboard shortcuts chosen in place of their defaults, by id
   *  ("ask", "newSession"), as the global-shortcut plugin reads them
   *  ("Control+Shift+Space"). */
  shortcuts: Record<string, string>;
  /** The sidebar's groups, in order, each with its agents and sessions by
   *  key (`agent:<hub>/<agent>`, `session:<id>`). */
  groups: DeskGroup[];
  /** Ungrouped's order and whether it's collapsed. */
  ungrouped: Ungrouped;
  /** Names you've given sessions in Desk, by Desk session id; shown in
   *  place of the hub's everywhere Desk shows the session. */
  sessionNames: Record<string, string>;
  /** The groups and names above were handed to the local hub, which keeps
   *  them from then on; they stay here for a hub that can't. */
  layoutOnHub?: boolean;
}

export interface ThemeFile {
  id: string;
  source: string;
}

export const hubConnection = (): Promise<HubConnection> => invoke("hub_connection");

export const loadSettings = (): Promise<Settings> => invoke("settings_load");

export const saveSettings = (settings: Settings): Promise<void> => invoke("settings_save", { settings });

export const themeFiles = (): Promise<ThemeFile[]> => invoke("themes_list");

export const writeTheme = (id: string, source: string): Promise<void> => invoke("themes_write", { id, source });

export const revealThemes = (): Promise<void> => invoke("themes_reveal");

export const onThemesChanged = (f: () => void): Promise<() => void> => listen("themes-changed", f);

export const pickFolder = async (): Promise<string | null> => {
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
};

/** Desk's Claude Code plugin folder, which grid terminals' shells load so
 *  a `claude` started there is tracked; null outside the app. */
export const claudePluginDir = async (): Promise<string | null> => (preview ? null : invoke<string | null>("claude_plugin_dir"));

/** What's running in a terminal whose shell is `pid`, shell first; empty
 *  where Desk can't look (outside the app). */
export const programsUnder = async (pid: number): Promise<string[]> => (preview ? [] : invoke<string[]>("programs_under", { pid }));

/** A monitor as Desk recognises it again (see src-tauri/src/grid_windows.rs). */
export interface MonitorInfo {
  /** `name:WxH@scale`. */
  id: string;
  name: string;
  /** Its work area's origin, in points: tells identical monitors apart. */
  origin: [number, number];
  primary: boolean;
}

export type GridWindowMode = "fill" | "free" | "fullscreen";

/** Opens grid `grid`'s own window on its monitor (or brings it forward);
 *  null while that monitor isn't connected. */
export const openGridWindow = (
  grid: string,
  title: string,
  mode: GridWindowMode,
  monitor: { id: string; origin: [number, number] } | null,
): Promise<MonitorInfo | null> => invoke("grid_window_open", { grid, title, mode, monitor });
export const closeGridWindow = (grid: string): Promise<void> => invoke("grid_window_close", { grid });
/** The grids that have a window of their own now. */
export const gridWindowsOpen = (): Promise<string[]> => invoke("grid_windows_open");
/** Puts this (grid) window in a window mode. */
export const setGridWindowMode = (mode: GridWindowMode): Promise<void> => invoke("grid_window_mode", { mode });
/** The monitor this window is on. */
export const gridWindowMonitor = (): Promise<MonitorInfo | null> => invoke("grid_window_monitor");
export const monitorsNow = (): Promise<MonitorInfo[]> => invoke("grid_monitors");

/** The local hub (once Desk is paired with it) and every paired remote hub. */
export const hubAccounts = (): Promise<HubAccount[]> => invoke("hubs_list");

/** Opens a page in the default browser; in the browser preview, a new tab. */
export const openUrl = (url: string): void => {
  if (preview) window.open(url, "_blank", "noopener");
  else void openExternal(url);
};

export const saveHub = (label: string, url: string, token: string): Promise<{ id: string }> =>
  invoke("hubs_save", { label, url, token });

export const removeHub = (id: string): Promise<void> => invoke("hubs_remove", { id });

export interface TupleRequest {
  agent: string | null;
  text: string;
  context: string[];
}

export type TupleStatus = { state: "off" } | { state: "following" } | { state: "unavailable"; reason: string };

export const enableTuple = (names: string[]): Promise<void> => invoke("tuple_enable", { names });
export const disableTuple = (): Promise<void> => invoke("tuple_disable");
export const replyOnTuple = (agent: string, answer: string): Promise<void> => invoke("tuple_reply", { agent, answer });
export const onTupleRequest = (f: (r: TupleRequest) => void): Promise<() => void> =>
  listen<TupleRequest>("tuple-request", (e) => f(e.payload));
export const onTupleStatus = (f: (s: TupleStatus) => void): Promise<() => void> =>
  listen<TupleStatus>("tuple-state", (e) => f(e.payload));

export type PlanName = "claude" | "chatgpt";

export type LoginProgress =
  | { state: "starting" }
  | { state: "browser"; url: string }
  | { state: "needs-code" }
  | { state: "saving" }
  | { state: "done" }
  | { state: "failed"; message: string };

/** Connects a plan through its own sign-in (the real `claude` / `codex`
 *  CLI); progress arrives through `onLoginProgress`. */
export const startLogin = (plan: PlanName): Promise<void> => invoke("login_start", { plan });
export const sendLoginCode = (plan: PlanName, code: string): Promise<void> => invoke("login_code", { plan, code });
export const cancelLogin = (plan: PlanName): Promise<void> => invoke("login_cancel", { plan });
export const onLoginProgress = (f: (plan: PlanName, p: LoginProgress) => void): Promise<() => void> =>
  listen<{ plan: PlanName } & LoginProgress>("login-progress", (e) => {
    const { plan, ...progress } = e.payload;
    f(plan, progress as LoginProgress);
  });

/** Desk Helper — what keeps the agents and sessions on this Mac running —
 *  as a login item. */
export type HelperStatus =
  | { state: "running" }
  | { state: "needs-approval" }
  | { state: "not-registered" }
  | { state: "move-to-applications" }
  | { state: "development" }
  | { state: "failed"; message: string };

export const helperStatus = (): Promise<HelperStatus> => invoke("helper_status");
export const openLoginItems = (): Promise<void> => invoke("helper_open_login_items");

export type InstallProgress = { state: "running"; line: string } | { state: "done" } | { state: "failed"; message: string };

/** Whether the CLI a plan signs in with (`claude`, `codex`) is on this Mac. */
export const cliInstalled = (plan: PlanName): Promise<boolean> => invoke("cli_installed", { plan });
/** Runs its official installer; progress arrives through `onInstallProgress`. */
export const installCli = (plan: PlanName): Promise<void> => invoke("cli_install", { plan });
export const onInstallProgress = (f: (plan: PlanName, p: InstallProgress) => void): Promise<() => void> =>
  listen<{ plan: PlanName } & InstallProgress>("cli-install", (e) => {
    const { plan, ...progress } = e.payload;
    f(plan, progress as InstallProgress);
  });

/** Saves a zip of recent logs, secrets taken out, where the person chose. */
export const saveReport = (path: string, about: string): Promise<void> => invoke("report_save", { path, about });

/** Stops Desk Helper and takes it out of Login Items; with `everything`,
 *  also deletes Desk's folder and keychain items. */
export const removeDeskData = (everything: boolean): Promise<void> => invoke("data_remove", { everything });

/** Sessions to resume once Desk has restarted into an update. */
export const resumeLater = (ids: string[]): Promise<void> => invoke("resume_later", { ids });
export const takeResume = (): Promise<string[]> => invoke("resume_take");

/** Desk's own copy of what it restores (see restore/store.ts). */
export interface StateEntry {
  value: unknown;
  updatedAt?: string | null;
  dirty?: boolean;
}
export const stateLoad = (): Promise<Record<string, StateEntry>> => invoke("desk_state_load");
export const statePut = (key: string, value: unknown): Promise<void> => invoke("desk_state_put", { key, value });
export const stateRemove = (key: string): Promise<void> => invoke("desk_state_remove", { key });
export const stateSynced = (key: string, value: unknown, updatedAt: string | null): Promise<void> =>
  invoke("desk_state_synced", { key, value, updatedAt });
export const stateAdopt = (key: string, value: unknown, updatedAt: string | null): Promise<boolean> =>
  invoke("desk_state_adopt", { key, value, updatedAt });
export const stateFlush = (): Promise<void> => invoke("desk_state_flush");
/** Changes Desk's native side made to it (a window's frame). */
export const onNativeState = (f: (changes: [string, StateEntry][]) => void): Promise<() => void> =>
  listen<[string, StateEntry][]>("desk-state", (e) => f(e.payload));
/** The page has put back what was open: the window can be shown. */
export const deskReady = (): Promise<void> => invoke("desk_ready");
