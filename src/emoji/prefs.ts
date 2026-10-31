// The emoji you've used lately and the skin tone you picked, kept with the
// rest of what Desk restores (`ui.emoji`), so they follow you across
// launches and onto the hub.

import { useSyncExternalStore } from "react";
import { deskState } from "../restore/boot";
import type { DeskStateStore } from "../restore/store";
import { TONES, type Tone } from "./data";

export const EMOJI_KEY = "ui.emoji";

/** How many recent emoji the picker shows. */
export const RECENT_MAX = 18;

export interface EmojiPrefs {
  /** Most recent first, as chosen (in their skin tone). */
  recent: string[];
  tone: Tone;
}

const NONE: EmojiPrefs = { recent: [], tone: "none" };

let cached: { raw: unknown; prefs: EmojiPrefs } | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

/** What's kept, read leniently: anything unreadable is left out. */
export const readPrefs = (store: DeskStateStore = deskState): EmojiPrefs => {
  const raw = store.get(EMOJI_KEY);
  if (cached && cached.raw === raw) return cached.prefs;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const recent = Array.isArray(o.recent) ? o.recent.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  const tone = TONES.includes(o.tone as Tone) ? (o.tone as Tone) : "none";
  const prefs = raw === undefined ? NONE : { recent, tone };
  cached = { raw, prefs };
  return prefs;
};

/** `emoji` as the most recent. */
export const used = (emoji: string, store: DeskStateStore = deskState): void => {
  const p = readPrefs(store);
  store.set(EMOJI_KEY, { ...p, recent: [emoji, ...p.recent.filter((e) => e !== emoji)].slice(0, RECENT_MAX) });
  changed();
};

export const setTone = (tone: Tone, store: DeskStateStore = deskState): void => {
  store.set(EMOJI_KEY, { ...readPrefs(store), tone });
  changed();
};

/** What's kept, as it changes here (what the hub sends shows from the next
 *  render). */
export function useEmojiPrefs(store: DeskStateStore = deskState): EmojiPrefs {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => void listeners.delete(f);
    },
    () => readPrefs(store),
  );
}
