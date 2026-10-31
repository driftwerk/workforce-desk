import { create } from "zustand";
import { placeKey, type Place } from "./places";

// What this window shows now: a place on screen in a focused Desk window
// has nothing unread in it, whatever arrives while it stays. Each window
// keeps its own; one shown in another window is read through its point.
// A place you mark unread while it shows is left unread until it's shown
// again.

interface WatchingState {
  /** Places on screen here, by place key: how many views show each. */
  on: Record<string, number>;
  /** Places marked unread while they stood on screen. */
  held: Record<string, true>;
}

export const useWatching = create<WatchingState>(() => ({ on: {}, held: {} }));

/** A view of `key` came on screen. */
export const watchOn = (key: string): void =>
  useWatching.setState((s) => ({ on: { ...s.on, [key]: (s.on[key] ?? 0) + 1 } }));

/** A view of `key` went out of sight. */
export const watchOff = (key: string): void =>
  useWatching.setState((s) => {
    const n = (s.on[key] ?? 0) - 1;
    const { [key]: _gone, ...rest } = s.on;
    return { on: n > 0 ? { ...rest, [key]: n } : rest };
  });

/** `place` was marked unread here: while it stays on screen it isn't read
 *  again. One not on screen reads as usual once it's shown. */
export const hold = (place: Place): void =>
  useWatching.setState((s) => {
    const key = placeKey(place);
    return s.on[key] ? { held: { ...s.held, [key]: true } } : s;
  });

/** `key` went out of sight: it reads as usual when it's shown again. */
export const release = (key: string): void =>
  useWatching.setState((s) => {
    if (!s.held[key]) return s;
    const { [key]: _gone, ...held } = s.held;
    return { held };
  });

/** Whether `key` is on screen here and wasn't marked unread there. */
export const watched = (s: WatchingState, key: string): boolean => (s.on[key] ?? 0) > 0 && !s.held[key];
