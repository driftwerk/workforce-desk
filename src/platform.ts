import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl as openExternal } from "@tauri-apps/plugin-opener";
import type { Attachment, HubAccount } from "./chat/types";
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

/** The font families installed on this computer, sorted. */
export const systemFonts = (): Promise<string[]> => invoke("fonts_list");

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
  else openExternal(url).catch((e: unknown) => console.warn(`couldn't open ${url} in the browser:`, e));
};

export const saveHub = (label: string, url: string, token: string): Promise<{ id: string }> =>
  invoke("hubs_save", { label, url, token });

export const removeHub = (id: string): Promise<void> => invoke("hubs_remove", { id });

// ── Files in conversations ────────────────────────────────────────────────
// Their bytes come through Desk's native side, which holds each hub's
// token: the page never puts a token in a URL. The browser preview, which
// has no native side, asks the hub directly.

/** Where a file of agent `agent` on hub `hub` is shown from: an image's
 *  `src`, a player's (which seeks by range). Desk's `deskfile:` scheme is
 *  served where the webview serves it: `deskfile://localhost/` on macOS and
 *  Linux, `http://deskfile.localhost/` on Windows. */
export const fileUrl = (hub: HubAccount, agent: string, artifact: string): string =>
  preview
    ? `${new URL(`/api/agents/${encodeURIComponent(agent)}/attachments/${encodeURIComponent(artifact)}`, hub.url)}?token=${encodeURIComponent(hub.token)}`
    : `${convertFileSrc("", "deskfile")}${[hub.id, agent, artifact].map(encodeURIComponent).join("/")}`;

/** Opens a file in the app this computer opens its kind with. */
export const openFile = (hub: HubAccount, agent: string, artifact: string, filename: string): Promise<void> =>
  preview ? Promise.resolve(void window.open(fileUrl(hub, agent, artifact), "_blank", "noopener")) : invoke("attachment_open", { hub: hub.id, agent, artifact, filename });

/** `name` as a file's name on any system: no folders, none of the
 *  characters Windows refuses, no trailing dots or spaces, and none of the
 *  names it keeps for devices. */
export const safeFilename = (name: string): string => {
  const base = (name.split(/[/\\]/).pop() ?? "")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/, "");
  return !base || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base) ? `_${base}` : base;
};

/** Asks where to save a file, and saves it there; false when the person
 *  thought better of it. */
export const saveFileAs = async (hub: HubAccount, agent: string, artifact: string, filename: string): Promise<boolean> => {
  if (preview) {
    const a = Object.assign(document.createElement("a"), { href: fileUrl(hub, agent, artifact), download: filename });
    a.click();
    return true;
  }
  const path = await save({ defaultPath: safeFilename(filename) });
  if (!path) return false;
  await invoke("attachment_save", { hub: hub.id, agent, artifact, path });
  return true;
};

/** Uploads `file` to agent `agent`'s conversation on `channel`, as the hub
 *  then describes it. Throws what the hub said when it refused. */
export const uploadFile = async (hub: HubAccount, agent: string, channel: string, file: File): Promise<Attachment> => {
  if (preview) {
    const url = new URL(`/api/agents/${encodeURIComponent(agent)}/attachments`, hub.url);
    url.search = new URLSearchParams({ channel, filename: file.name }).toString();
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${hub.token}` }, body: file });
    const body = (await res.json().catch(() => ({}))) as Attachment & { error?: string };
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  }
  return tauriInvoke<Attachment>("attachment_upload", new Uint8Array(await file.arrayBuffer()), {
    headers: {
      "x-desk-hub": encodeURIComponent(hub.id),
      "x-desk-agent": encodeURIComponent(agent),
      "x-desk-channel": encodeURIComponent(channel),
      "x-desk-filename": encodeURIComponent(file.name),
    },
  });
};

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

/** Desk Helper — what keeps the agents and sessions on this computer running —
 *  started at login. */
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

/** Whether the CLI a plan signs in with (`claude`, `codex`) is on this computer. */
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

/** Stops Desk Helper and takes it out of what starts at login; with
 *  `everything`, also deletes Desk's folders and the secrets it keeps. */
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
