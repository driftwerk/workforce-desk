import { emit } from "@tauri-apps/api/event";
import { inApp, listen } from "../platform";
import { useSettings } from "../settings/store";
import { FEATURES } from "./types";

// "Always reply in a thread", per agent: each new message you send in the
// agent's DM starts a thread on itself and the agent answers in it, as in
// Slack, so each conversation is a session of its own. Kept with Desk's
// settings on this computer, and told to its other windows as it changes.

const CHANGED = "desk-thread-replies";

/** Whether a hub can start a thread on a new DM message: it has DM threads,
 *  and keeps a message that starts one in the DM as its parent. */
export const canStartThreads = (features: ReadonlySet<string> | null | undefined): boolean =>
  !!features?.has(FEATURES.dmThreads) && !!features.has(FEATURES.threadStarts);

/** Whether agent `key` always replies in a thread (the setting alone). */
export const useRepliesInThreads = (key: string | null | undefined): boolean =>
  useSettings((s) => !!key && s.threadReplies.includes(key));

/** Turns "Always reply in a thread" on or off for agent `key`, here and in
 *  Desk's other windows. */
export const setRepliesInThreads = (key: string, on: boolean): void => {
  const { threadReplies, set } = useSettings.getState();
  const others = threadReplies.filter((k) => k !== key);
  const next = on ? [...others, key] : others;
  set({ threadReplies: next });
  if (inApp) void emit(CHANGED, next).catch(() => undefined);
};

/** Follows the setting as another window changes it, so this one never saves
 *  an older list over it. Mount once per window. */
export const followRepliesInThreads = () =>
  listen<unknown>(CHANGED, (e) => {
    const next = Array.isArray(e.payload) ? e.payload.filter((k): k is string => typeof k === "string") : null;
    if (next) useSettings.setState({ threadReplies: next });
  });

/** Whether `text` is a command for the hub (`/status`, `/model x`): one it
 *  answers itself, which acts on the conversation it's typed in, so in the
 *  DM it stays there rather than starting a thread. */
export const isCommand = (text: string, commands: readonly { name: string; aliases: readonly string[] }[]): boolean => {
  const word = /^\/([^\s/]+)/.exec(text.trimStart())?.[1]?.toLowerCase();
  if (!word) return false;
  // Before the hub's list is read, any `/word` is taken for one.
  if (!commands.length) return true;
  const bare = (n: string) => n.replace(/^\//, "").toLowerCase();
  return commands.some((c) => bare(c.name) === word || c.aliases.some((a) => bare(a) === word));
};
