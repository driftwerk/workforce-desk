import { create } from "zustand";
import type { Platform } from "../shell/host";
import type { ItemKey } from "./model";

/** The rows picked in the sidebar, as Finder and Mail pick them: a click
 *  picks one alone, ⌘-click (Ctrl elsewhere) one more or one less,
 *  shift-click a range. Two or more are a selection to act on together.
 *  Kept here, not in the sidebar, so it outlives each time the sidebar is
 *  drawn. */
interface Selection {
  keys: ReadonlySet<ItemKey>;
  /** Where the next range starts: the last row picked one at a time. */
  anchor: ItemKey | null;
  /** What was picked before the range from the anchor: a shift-click
   *  redraws that range, so it shrinks as well as grows. */
  base: ReadonlySet<ItemKey>;
  /** The rows that can be picked now, in the order the sidebar shows them:
   *  nothing out of sight stays picked. */
  shown: readonly ItemKey[];
}

const NONE: ReadonlySet<ItemKey> = new Set();

export const useSelection = create<Selection>(() => ({ keys: NONE, anchor: null, base: NONE, shown: [] }));

/** Whether `s` is a selection to act on together: two rows or more. */
export const isBulk = (s: Pick<Selection, "keys">): boolean => s.keys.size >= 2;

/** Whether `key` is in a selection to act on together. */
export const inBulk = (key: ItemKey): boolean => {
  const s = useSelection.getState();
  return isBulk(s) && s.keys.has(key);
};

/** The rows from `anchor` to `key` in `order`, both included; `key` alone
 *  when there's no anchor in it, none when `key` isn't. */
export const between = (order: readonly ItemKey[], anchor: ItemKey | null, key: ItemKey): ItemKey[] => {
  const to = order.indexOf(key);
  if (to < 0) return [];
  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (from < 0) return [key];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
};

type Mods = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };

/** The platform's own modifier is held: ⌘ on macOS, Ctrl elsewhere. */
export const modHeld = (e: Pick<Mods, "metaKey" | "ctrlKey">, platform: Platform): boolean => (platform === "macos" ? e.metaKey : e.ctrlKey);

/** What a click does to the selection: shift picks a range, the platform's
 *  own modifier one row more or less; null picks the row alone and opens
 *  it. */
export const pickOf = (e: Mods, platform: Platform): "range" | "toggle" | null =>
  e.shiftKey ? "range" : modHeld(e, platform) ? "toggle" : null;

/** Picks `key` alone. */
export const only = (key: ItemKey): void => {
  const keys = new Set([key]);
  useSelection.setState({ keys, anchor: key, base: keys });
};

/** Picks `key`, or lets it go when it was picked. */
export const toggle = (key: ItemKey): void =>
  useSelection.setState((s) => {
    const keys = new Set(s.keys);
    if (!keys.delete(key)) keys.add(key);
    return { keys, anchor: key, base: keys };
  });

/** Picks the rows from the anchor to `key`, as they're shown, in place of
 *  the range picked from it before. */
export const extend = (key: ItemKey): void =>
  useSelection.setState((s) => {
    const base = s.anchor === null ? s.keys : s.base;
    return { keys: new Set([...base, ...between(s.shown, s.anchor, key)]), anchor: s.anchor ?? key, base };
  });

/** Picks every row in `keys`, all those shown unless said. */
export const selectAll = (keys: readonly ItemKey[] = useSelection.getState().shown): void => {
  const picked = new Set(keys);
  useSelection.setState({ keys: picked, anchor: keys[0] ?? null, base: picked });
};

export const clearSelection = (): void =>
  useSelection.setState((s) => (s.keys.size || s.anchor !== null ? { keys: NONE, anchor: null, base: NONE } : s));

/** Keeps only the picked rows `keep` says. Nothing changes when all are
 *  kept. */
export const keepOnly = (keep: (key: ItemKey) => boolean): void =>
  useSelection.setState((s) => {
    const left = [...s.keys].filter(keep);
    if (left.length === s.keys.size && (s.anchor === null || keep(s.anchor))) return s;
    return { keys: new Set(left), anchor: s.anchor !== null && keep(s.anchor) ? s.anchor : null, base: new Set([...s.base].filter(keep)) };
  });

/** The rows the sidebar shows now, in order: a picked one gone from sight
 *  (closed, removed, its group collapsed) is let go. */
export const showRows = (order: readonly ItemKey[]): void => {
  const here = new Set(order);
  useSelection.setState({ shown: order });
  keepOnly((key) => here.has(key));
};

/** Whether a key pressed at `target` is the person's typing or a dialog's:
 *  Escape and ⌘A there aren't the selection's. */
export const typedIn = (target: EventTarget | null): boolean =>
  target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, [role="dialog"]');
