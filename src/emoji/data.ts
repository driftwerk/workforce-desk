// Every emoji, with its name, keywords and shortcodes, from Emojibase: loaded
// the first time something needs it (a `:shortcode` typed, the picker
// opened), as chunks of their own and never from the network, and only the
// emoji this computer can draw.

import { useEffect, useSyncExternalStore } from "react";
import { EMOJI_STACK } from "../theme/tokens";

export type Tone = "none" | "light" | "medium-light" | "medium" | "medium-dark" | "dark";
export type SkinTone = Exclude<Tone, "none">;

/** Emojibase's tones, 1 to 5, by name. */
export const TONES: readonly Tone[] = ["none", "light", "medium-light", "medium", "medium-dark", "dark"];

export interface EmojiEntry {
  emoji: string;
  /** As CLDR names it: "red heart". */
  label: string;
  group: number;
  order: number;
  version: number;
  tags: string[];
  /** GitHub's names first (`heart`, `heart_eyes`), then Emojibase's. */
  shortcodes: string[];
  /** The same emoji in each skin tone, where it has them. */
  skins?: Record<SkinTone, string>;
}

export interface EmojiSet {
  /** In the order a keyboard shows them. */
  entries: EmojiEntry[];
  byShortcode: ReadonlyMap<string, EmojiEntry>;
  /** The picker's categories (the skin tone components aren't one). */
  groups: { index: number; label: string }[];
  /** Each tone's name: "Light skin tone". */
  tones: Record<SkinTone, string>;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Whether this computer draws `emoji` as one emoji, in colour: a glyph it
 *  lacks comes out as a box or as its parts side by side, and either is
 *  drawn in the fill colour where an emoji keeps its own. */
const draws = (ctx: CanvasRenderingContext2D, emoji: string): boolean => {
  const size = 16;
  if (ctx.measureText(emoji).width >= size * 1.5) return false;
  const pixels = (fill: string) => {
    ctx.clearRect(0, 0, size * 2, size * 2);
    ctx.fillStyle = fill;
    ctx.fillText(emoji, 0, 0);
    return ctx.getImageData(0, 0, size * 2, size * 2).data;
  };
  const blue = pixels("#00f");
  const red = pixels("#f00");
  let inked = false;
  for (let i = 0; i < blue.length; i += 4) {
    if (blue[i + 3]) inked = true;
    if (blue[i] !== red[i] || blue[i + 1] !== red[i + 1] || blue[i + 2] !== red[i + 2]) return false;
  }
  return inked;
};

const canvas = (): CanvasRenderingContext2D | null => {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.font = `16px ${EMOJI_STACK}`;
    ctx.textBaseline = "top";
    return ctx;
  } catch {
    return null;
  }
};

/** The newest emoji version this computer draws, and whether it draws
 *  flags (Windows doesn't); everything, where it can't be told: no canvas,
 *  one that can't be read, or no colour emoji at all (a Linux without an
 *  emoji font), where leaving all out would leave nothing to pick. */
export const drawable = (
  entries: readonly { emoji: string; version: number }[],
  ctx: CanvasRenderingContext2D | null = canvas(),
): { version: number; flags: boolean } => {
  const all = { version: Infinity, flags: true };
  if (!ctx) return all;
  const first = new Map<number, string>();
  for (const e of entries) if (!first.has(e.version)) first.set(e.version, e.emoji);
  const versions = [...first.keys()].sort((a, b) => b - a);
  try {
    const version = versions.find((v) => draws(ctx, first.get(v)!));
    return version === undefined ? all : { version, flags: draws(ctx, "\u{1F1EA}\u{1F1FA}") };
  } catch {
    return all;
  }
};

type Shortcodes = Record<string, string | string[]>;
const codes = (set: Shortcodes, hexcode: string): string[] => {
  const v = set[hexcode];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};

/** Builds the set from Emojibase's datasets (exported for tests). */
export const buildSet = (
  data: readonly import("emojibase").Emoji[],
  messages: import("emojibase").MessagesDataset,
  github: Shortcodes,
  emojibase: Shortcodes,
  can: { version: number; flags: boolean },
): EmojiSet => {
  const flags = messages.subgroups.find((s) => s.key === "country-flag")?.order;
  const component = messages.groups.find((g) => g.key === "component")?.order;
  const entries: EmojiEntry[] = [];
  for (const e of data) {
    if (e.group === undefined || e.group === component || e.version > can.version) continue;
    if (!can.flags && flags !== undefined && e.subgroup === flags) continue;
    const skins = e.skins?.filter((s) => typeof s.tone === "number");
    entries.push({
      emoji: e.emoji,
      label: e.label,
      group: e.group,
      order: e.order ?? Infinity,
      version: e.version,
      tags: e.tags ?? [],
      shortcodes: [...new Set([...codes(github, e.hexcode), ...codes(emojibase, e.hexcode)])],
      ...(skins?.length === 5 ? { skins: Object.fromEntries(skins.map((s) => [TONES[s.tone as number], s.emoji])) as Record<SkinTone, string> } : {}),
    });
  }
  entries.sort((a, b) => a.order - b.order);
  const byShortcode = new Map<string, EmojiEntry>();
  for (const e of entries) for (const c of e.shortcodes) if (!byShortcode.has(c)) byShortcode.set(c, e);
  return {
    entries,
    byShortcode,
    groups: messages.groups.filter((g) => g.order !== component).map((g) => ({ index: g.order, label: capital(g.message) })),
    tones: Object.fromEntries(messages.skinTones.map((t) => [t.key, capital(t.message)])) as Record<SkinTone, string>,
  };
};

let set: EmojiSet | null = null;
let loading: Promise<EmojiSet> | null = null;
const listeners = new Set<() => void>();

/** The emoji, once loaded. */
export const loadEmoji = (): Promise<EmojiSet> =>
  (loading ??= Promise.all([
    import("emojibase-data/en/data.json"),
    import("emojibase-data/en/messages.json"),
    import("emojibase-data/en/shortcodes/github.json"),
    import("emojibase-data/en/shortcodes/emojibase.json"),
  ])
    .then(([data, messages, github, emojibase]) => {
      set = buildSet(data.default, messages.default, github.default, emojibase.default, drawable(data.default));
      for (const f of listeners) f();
      return set;
    })
    .catch((err: unknown) => {
      // Asked for again next time.
      loading = null;
      throw err;
    }));

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};

/** The emoji set, loaded once `wanted` (null until it is). */
export function useEmojiSet(wanted = true): EmojiSet | null {
  const shown = useSyncExternalStore(subscribe, () => set);
  useEffect(() => {
    if (wanted && !set) loadEmoji().catch(() => undefined);
  }, [wanted]);
  return shown;
}

/** `entry` in `tone`, where it has skin tones. */
export const inTone = (entry: Pick<EmojiEntry, "emoji" | "skins">, tone: Tone): string =>
  tone !== "none" && entry.skins ? entry.skins[tone] : entry.emoji;
