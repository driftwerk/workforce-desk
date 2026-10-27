import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl as openExternal } from "@tauri-apps/plugin-opener";
import type { HubAccount } from "./chat/types";
import type { HubConnection } from "./hub/client";

/** The browser preview bridge runs only under `vite dev`, never in tests or builds. */
const preview = import.meta.env.MODE === "development" && !("__TAURI_INTERNALS__" in window);

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

export interface Settings {
  theme: string;
  tuple: boolean;
  /** The plan new agents start on: "claude" | "chatgpt", or null for
   *  whichever is connected. */
  plan: string | null;
  defaultVoice: VoiceSpec;
  /** Agents' own voices, by agent key. */
  agentVoices: Record<string, VoiceSpec>;
  voice: boolean;
  /** "cascade" (on-device), "gpt-live" or "gemini-live". */
  voiceEngine: string;
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

/** The local hub (once Desk is paired with it) and every paired remote hub. */
export const hubAccounts = (): Promise<HubAccount[]> => invoke("hubs_list");

export const openUrl = (url: string): void => {
  void openExternal(url);
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
