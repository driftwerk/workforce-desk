import { create } from "zustand";
import type { Platform } from "../shell/host";
import type { ItemKey } from "./model";

/** The sessions picked in the sidebar to close together: shift-click picks
 *  a range, cmd-click (ctrl elsewhere) one more or one less, and in select
 *  mode a plain click does. Kept here, not in the sidebar, so it outlives
 *  each time the sidebar is drawn. */
interface Selection {
  keys: ReadonlySet<ItemKey>;
  /** Where the next range starts: the last row picked one at a time. */
  anchor: ItemKey | null;
  /** What was picked before the range from the anchor: a shift-click
   *  redraws that range, so it shrinks as well as grows. */
  base: ReadonlySet<ItemKey>;
  /** Select mode: a plain click picks, as for a pointer with no keyboard. */
  selecting: boolean;
}

const none: Selection = { keys: new Set(), anchor: null, base: new Set(), selecting: false };

export const useSelection = create<Selection>(() => none);

/** The rows from `anchor` to `key` in `order`, both included; `key` alone
 *  when there's no anchor in it, none when `key` isn't. */
export const between = (order: readonly ItemKey[], anchor: ItemKey | null, key: ItemKey): ItemKey[] => {
  const to = order.indexOf(key);
  if (to < 0) return [];
  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (from < 0) return [key];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
};

/** What a click does to the selection: shift picks a range, the
 *  platform's own modifier (⌘ or Ctrl) one row, and in
 *  select mode so does a plain click; null opens the row as always. */
export const pickOf = (
  e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  platform: Platform,
  selecting: boolean,
): "range" | "toggle" | null => {
  if (e.shiftKey) return "range";
  if ((platform === "macos" ? e.metaKey : e.ctrlKey) || selecting) return "toggle";
  return null;
};

/** Picks `key`, or lets it go when it was picked. */
export const toggle = (key: ItemKey): void =>
  useSelection.setState((s) => {
    const keys = new Set(s.keys);
    if (!keys.delete(key)) keys.add(key);
    return { keys, anchor: key, base: keys };
  });

/** Picks the rows from the anchor to `key`, as `order` shows them, in place
 *  of the range picked from it before. */
export const extend = (order: readonly ItemKey[], key: ItemKey): void =>
  useSelection.setState((s) => {
    const base = s.anchor === null ? s.keys : s.base;
    return { keys: new Set([...base, ...between(order, s.anchor, key)]), anchor: s.anchor ?? key, base };
  });

export const startSelecting = (): void => useSelection.setState({ selecting: true });

export const clearSelection = (): void => useSelection.setState(none);

/** Keeps only the picked rows `keep` says: those still shown, or those not
 *  closed yet. Nothing changes when all are kept. */
export const keepOnly = (keep: (key: ItemKey) => boolean): void =>
  useSelection.setState((s) => {
    const left = [...s.keys].filter(keep);
    if (left.length === s.keys.size) return s;
    return { keys: new Set(left), anchor: s.anchor !== null && keep(s.anchor) ? s.anchor : null, base: new Set([...s.base].filter(keep)) };
  });

/** Whether a key pressed at `target` is the person's typing or a dialog's:
 *  Escape there isn't the selection's. */
export const typedIn = (target: EventTarget | null): boolean =>
  target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, [role="dialog"]');
