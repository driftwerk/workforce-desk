// `:shortcode:` in a composer: `:hea` offers ❤️ heart, 😍 heart_eyes…, and a
// finished `:smile:` is its emoji.

import type { EmojiEntry, EmojiSet } from "./data";
import { inCode } from "./emoticons";

/** The `:name` being typed at `caret`, if any: where its colon is, and
 *  what's after it. Its colon is at the start or after a space or a
 *  bracket, and two letters at least follow it, so `Note:this`, `https:`,
 *  `10:30` and `:)` don't open anything. */
export const shortcodeAt = (text: string, caret: number): { start: number; query: string } | null => {
  const m = /(?:^|[\s(]):([a-z]{2}[a-z0-9_+-]*)$/i.exec(text.slice(0, caret));
  if (!m) return null;
  const start = caret - m[1]!.length - 1;
  return inCode(text, start) ? null : { start, query: m[1]!.toLowerCase() };
};

/** The finished `:name` before `caret`, as the closing colon is typed: its
 *  emoji, when it's one. */
export const shortcodeBefore = (
  text: string,
  caret: number,
  set: Pick<EmojiSet, "byShortcode">,
): { start: number; end: number; typed: string; entry: EmojiEntry } | null => {
  const m = /(?:^|[\s(]):([a-z0-9_+-]+)$/i.exec(text.slice(0, caret));
  const entry = m && set.byShortcode.get(m[1]!.toLowerCase());
  if (!m || !entry) return null;
  const start = caret - m[1]!.length - 1;
  return inCode(text, start) ? null : { start, end: caret, typed: `:${m[1]!}:`, entry };
};

export interface Suggestion {
  entry: EmojiEntry;
  /** The shortcode it was found by. */
  name: string;
}

/** Emoji whose shortcode starts with `query`, shortest first (so `:hea`
 *  is heart before heart_eyes); then those with a word of it that does. */
export const suggest = (query: string, set: Pick<EmojiSet, "entries">, limit = 8): Suggestion[] => {
  const q = query.toLowerCase();
  const whole: Suggestion[] = [];
  const word: Suggestion[] = [];
  for (const entry of set.entries) {
    const name = entry.shortcodes.find((c) => c.startsWith(q));
    if (name) {
      whole.push({ entry, name });
      continue;
    }
    const part = entry.shortcodes.find((c) => c.split(/[_-]/).some((w) => w.startsWith(q)));
    if (part) word.push({ entry, name: part });
  }
  const shortest = (a: Suggestion, b: Suggestion) => a.name.length - b.name.length || a.entry.order - b.entry.order;
  return [...whole.sort(shortest), ...word.sort(shortest)].slice(0, limit);
};
