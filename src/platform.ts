import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl as openExternal } from "@tauri-apps/plugin-opener";
import type { Attachment, HubAccount } from "./chat/types";
import type { BrainChoice } from "./crew/brain";
import type { DeskGroup, Ungrouped } from "./groups/model";
import type { HubConnection } from "./hub/client";
import { brokered } from "./hub/broker";
import { devToken } from "./hub/devTokens";
import { direct, type DeskTransport } from "./hub/transport";
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

/** Where the first-run setup stands (see `setup/`). */
export interface SetupProgress {
  /** Offered once: it isn't opened by itself again. */
  started: boolean;
  /** Closed by the person: shown again only when reopened. */
  closed: boolean;
  /** Steps skipped, by id. */
  skipped: string[];
  /** When it last changed (ISO): of two windows' writes, the later one's
   *  setup is kept. */
  at?: string;
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
  /** Agents, by agent key, who answer in writing when talked to in their
   *  DM; the rest answer aloud. Older files have none. */
  writtenReplies?: string[];
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
  /** Emoticons typed in a message (`<3`, `:)`) become emoji; older files
   *  have none (on). */
  emoticons?: boolean;
  /** Sites (host names, lowercased) whose pictures in agent markdown show
   *  without a click; older files have none. */
  imageSites?: string[];
  /** The first-run setup's progress; older files have none. */
  setup?: SetupProgress;
}

export interface ThemeFile {
  id: string;
  source: string;
}

/** The local hub's admin surface, once the hub is up (on first launch
 *  `desk-hubd` is still starting it). In the app it is reached only through
 *  Desk's native side, which holds the hub's token: the page never has it.
 *  The browser preview has no native side, and the dev bridge gives it a
 *  development hub's token. */
export const localHub = async (): Promise<DeskTransport> => {
  const c = await invoke<{ url: string } & Partial<HubConnection>>("hub_connection");
  return preview && c.token ? direct({ url: c.url, token: c.token }) : brokered;
};

export const loadSettings = (): Promise<Settings> => invoke("settings_load");

export const saveSettings = (settings: Settings): Promise<void> => invoke("settings_save", { settings });

/** A remote picture, fetched by Desk (never the page): the length of its
 *  meta's JSON (four bytes), that JSON (`{"mime"}`), then its bytes. Rejects
 *  with `{kind: "refused" | "failed", reason}`, or, `sameSite` (shown without
 *  a click), `{kind: "moved"}` when it redirects off its site. */
export const remoteImageFetch = (url: string, sameSite: boolean): Promise<ArrayBuffer> =>
  invoke("remote_image_fetch", { url, sameSite });

export const themeFiles = (): Promise<ThemeFile[]> => invoke("themes_list");

/** The font families installed on this computer, sorted. */
export const systemFonts = (): Promise<string[]> => invoke("fonts_list");

export const writeTheme = (id: string, source: string): Promise<void> => invoke("themes_write", { id, source });

export const revealThemes = (): Promise<void> => invoke("themes_reveal");

export const onThemesChanged = (f: () => void): Promise<() => void> => listen("themes-changed", f);

/** A folder for the backend to work in, as the backend names it (on
 *  Windows, inside WSL); null when the person cancels. */
export const pickFolder = async (): Promise<string | null> => {
  if (!preview) return invoke<string | null>("pick_folder");
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
};

/** The person's home folder where the backend runs. */
export const backendHome = (): Promise<string> => invoke("backend_home");

/** Desk's Claude Code plugin folder, which grid terminals' shells load so
 *  a `claude` started there is tracked; null outside the app. */
export const claudePluginDir = async (): Promise<string | null> => (preview ? null : invoke<string | null>("claude_plugin_dir"));

/** A machine's Desk plugin folder, as the machine names it
 *  (`<bin>/current/claude-plugin`); null outside the app. */
export const machinePluginDir = async (machine: string): Promise<string | null> =>
  preview ? null : invoke<string | null>("claude_plugin_dir", { machine });

/** A machine's home folder, as it says it over SSH: where `~` is there. */
export const machineHome = async (machine: string): Promise<string> => invoke<string>("machine_home", { machine });

/** The machines Desk drives, as the native side lists them (unread: see
 *  `readMachine`); none in the browser preview. */
export const machinesList = async (): Promise<unknown[]> => (preview ? [] : invoke<unknown[]>("machines_list"));

/** Any machine's state changed. */
export const onMachinesChanged = (f: () => void): Promise<() => void> => listen("machines-changed", f);

/** What's running in a terminal whose shell is `pid`, shell first; empty
 *  where Desk can't look (outside the app). */
export const programsUnder = async (pid: number): Promise<string[]> => (preview ? [] : invoke<string[]>("programs_under", { pid }));

/** One folder's repository, as Desk read it with git: its top folder (one
 *  for every worktree), its origin's address, its tracked workflows. */
export interface RepoFacts {
  folder: string;
  top: string;
  remote: string | null;
  workflows: string[];
}

/** The repositories of `folders`, for Act fully's suggestions; none where
 *  Desk can't look. */
export const repoFacts = async (folders: string[]): Promise<RepoFacts[]> =>
  folders.length === 0 ? [] : invoke<RepoFacts[]>("repo_facts", { folders }).catch(() => []);

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
/** Brings Desk's main window forward (shown, unminimised, focused). The
 *  main window's own: a grid's window asks it to (see grids/elsewhere.ts). */
export const focusMainWindow = (): Promise<void> => invoke("main_window_focus");
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
/** Where a link or setting that wouldn't open is said: the window's toast,
 *  set by the shell (a test may leave it unset). */
let openFailed: ((e: unknown) => void) | null = null;
export const setOpenReporter = (run: ((e: unknown) => void) | null): void => {
  openFailed = run;
};
export const reportOpenFailure = (e: unknown): void => openFailed?.(e);

export const openUrl = (url: string): void => {
  if (preview) window.open(url, "_blank", "noopener");
  else
    openExternal(url).catch((e: unknown) => {
      console.warn(`couldn't open ${url} in the browser:`, e);
      // The person pressed something: nothing opening must say why.
      reportOpenFailure(new Error("Desk couldn’t open that link."));
    });
};

/** A link clicked in a terminal, decided natively: Claude's and OpenAI's
 *  sign-in pages open at once, any other web page after a native question
 *  naming its real address, local ones never. True when it opened. */
export const openTerminalLink = (url: string): Promise<boolean> => invoke<boolean>("open_terminal_link", { url });

export const removeHub = (id: string): Promise<void> => invoke("hubs_remove", { id });
/** Names a paired workspace `label` (as it names itself): its id, address
 *  and sign-in stay. */
export const renameHub = (id: string, label: string): Promise<void> => invoke("hubs_rename", { id, label });

// ── Files in conversations ────────────────────────────────────────────────
// Their bytes come through Desk's native side, which holds each hub's
// token: the page has none. The browser preview, which has no native side,
// asks the hub directly with a development token of its own.

/** Where a file of agent `agent` on hub `hub` is shown from: an image's
 *  `src`, a player's (which seeks by range). Desk's `deskfile:` scheme is
 *  served where the webview serves it: `deskfile://localhost/` on macOS and
 *  Linux, `http://deskfile.localhost/` on Windows. */
export const fileUrl = (hub: HubAccount, agent: string, artifact: string): string =>
  preview
    ? `${new URL(`/api/agents/${encodeURIComponent(agent)}/attachments/${encodeURIComponent(artifact)}`, hub.url)}?token=${encodeURIComponent(devToken(hub.id))}`
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
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${devToken(hub.id)}` }, body: file });
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

/** Whether this computer has Tuple; never in the browser preview. */
export const tupleAvailable = async (): Promise<boolean> => (preview ? false : invoke<boolean>("tuple_available"));
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
  /** `account`: the Desk account a Claude sign-in went to, if it went to one. */
  | { state: "done"; account?: string }
  | { state: "failed"; message: string };

/** Where one Claude sign-in goes: to the crew's agents (the plan they run
 *  on), to a Desk account coding sessions run on (a new one, or `again`,
 *  whose sign-in it replaces), or both. Unsaid: to the agents alone. */
export interface ClaudeUse {
  agents: boolean;
  account?: { name?: string; makeDefault?: boolean; again?: string } | null;
}

/** Connects a plan through its own sign-in (the real `claude` / `codex`
 *  CLI); progress arrives through `onLoginProgress`. */
export const startLogin = (plan: PlanName, to?: ClaudeUse): Promise<void> => invoke("login_start", to ? { plan, to } : { plan });
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
  | { state: "no-wsl"; problem: WslProblem }
  | { state: "starting" }
  | { state: "port-unreachable" }
  | { state: "failed"; message: string };

export const helperStatus = (): Promise<HelperStatus> => invoke("helper_status");
export const openLoginItems = (): Promise<void> => invoke("helper_open_login_items");
/** Starts Desk Helper now, the way the system starts it at login (the
 *  installed app: its login item; a development run starts nothing), and
 *  says where it stands. */
export const startHelper = (): Promise<HelperStatus> => invoke("helper_start");
/** What `desk-hubd.log` last said about the helper stopping; null if it says
 *  nothing or can't be read. */
export const helperLastReason = (): Promise<string | null> => invoke("helper_last_reason");
/** How far Desk Helper has got since it last started, from its log. */
export type HelperStage = "starting" | "database" | "services" | "connecting";
export const helperProgress = (): Promise<HelperStage | null> => invoke("helper_progress");
/** Copies Desk into the Applications folder, quits, and opens the copy
 *  (macOS). Resolves only if it couldn't: it rejects with why. */
export const moveToApplications = (): Promise<void> => invoke("helper_move_to_applications");

export type InstallProgress =
  | { state: "running"; line: string }
  | { state: "done" }
  /** `command` is what to run in a terminal by hand; `hint` says where;
   *  `details` is what the installer last printed. */
  | { state: "failed"; message: string; command?: string; hint?: string; details?: string };

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

/** How this install gets a new version: by itself, or (a package) through
 *  the system's package manager, with a page to download one by hand. */
/** How this install of Desk gets a new version, as its native side
 *  decides it: `never` for a development build, or one whose program an
 *  update couldn't replace (not inside a `.app` bundle on macOS). */
export interface Updating {
  how: "itself" | "package" | "never";
  neverBecause: string | null;
  download: string | null;
  /** This computer's sessions are in the PTY holder: they keep running
   *  while Desk restarts. */
  sessionsKept: boolean;
}
export const updating = (): Promise<Updating> => invoke("updating");
/** The version a new check finds, or null; always null for `never`. */
export const updateCheck = (): Promise<string | null> => invoke("update_check");
/** Downloads what the last check found; refused unless it updates itself. */
export const updateDownload = (): Promise<void> => invoke("update_download");
/** Installs the download and restarts into it; refused natively unless
 *  this install updates itself. */
export const updateInstall = (version: string): Promise<void> => invoke("update_install", { version });

/** Why Desk can't run in WSL here, or in one distro (see crates/desk-wsl). */
export type WslProblem =
  | { kind: "not_installed" }
  | { kind: "no_distro" }
  | { kind: "wsl1"; distro: string }
  | { kind: "arch"; found: string }
  | { kind: "old_linux"; glibc: string }
  | { kind: "root_user"; distro: string };

export interface WslDistro {
  name: string;
  state: string;
  version: number;
  default: boolean;
}

/** What a WSL 2 distro said it is. */
export interface WslProbe {
  arch: string;
  kernel: string;
  user: string;
  home: string;
  automount: string;
  glibc: string;
}

export interface WslFound {
  distro: WslDistro;
  probe: WslProbe | null;
  problem: WslProblem | null;
}

export interface WslDetection {
  problem: WslProblem | null;
  distros: WslFound[];
}

export type SetupStep = "copy" | "check" | "start" | "reach" | "startup";
export type SetupState = "running" | "done" | "failed" | "blocked";
export interface SetupEvent {
  step: SetupStep;
  state: SetupState;
  note: string | null;
}

/** WSL on this Windows computer and its distros. */
export const detectWsl = (): Promise<WslDetection> => invoke("wsl_detect");
/** Installs WSL and Ubuntu as an administrator; Windows then restarts. */
export const installWsl = (): Promise<void> => invoke("wsl_install");
/** Forgets opening Desk after the restart WSL's install asks for. */
export const forgetWslResume = (): Promise<void> => invoke("wsl_forget_resume");
export const convertToWsl2 = (distro: string): Promise<void> => invoke("wsl_convert", { distro });
/** "Create a user": a normal user named after the Windows one, made the
 *  distro's default (it restarts; its files stay). Its name. */
export const createWslUser = (distro: string): Promise<string> => invoke("wsl_create_user", { distro });
/** The user "Create a user" makes, to say before it does. */
export const wslUserName = (): Promise<string> => invoke("wsl_user_name");
/** "Install Ubuntu alongside": a current Ubuntu beside a Linux too old for
 *  Desk, with a normal user. Its name, to set Desk up in. */
export const installUbuntuAlongside = (): Promise<string> => invoke("wsl_install_alongside");
/** Sets Desk up in `distro`; progress arrives through `onWslSetup`. */
export const setUpInWsl = (distro: string): Promise<void> => invoke("wsl_setup", { distro });
/** Turns on WSL's localhost forwarding and restarts WSL. */
export const fixWslForwarding = (distro: string): Promise<void> => invoke("wsl_fix_forwarding", { distro });
/** The backend's version inside WSL; null when it isn't there. */
export const wslBackendVersion = (): Promise<string | null> => invoke("wsl_installed");
export const onWslSetup = (f: (e: SetupEvent) => void): Promise<() => void> => listen<SetupEvent>("wsl-setup", (e) => f(e.payload));

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
/** The page has put back what was open and painted its theme: the window
 *  takes the theme's `background` and can be shown. */
export const deskReady = (background: string): Promise<void> => invoke("desk_ready", { background });
/** Keeps the window's own background (seen at its edges while it resizes)
 *  on the theme's. */
export const windowBackground = (background: string): Promise<void> => invoke("window_background", { background });
