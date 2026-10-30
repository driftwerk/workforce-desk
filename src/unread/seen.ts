import { useEffect, useRef, type RefObject } from "react";
import type { ReadPoint } from "../hub/types";
import { placeKey, type Place } from "./places";
import { advance } from "./reads";
import { useUnread } from "./summary";

// The one rule for read: something is read once it has been on screen for
// half a second while Desk's window has focus and is visible, wherever it
// shows. A list is read through its newest item whose bottom showed; a whole
// thing (a card, a pane, a notice) once half of it showed.

/** How long something must be on screen to be read. */
export const SEEN_MS = 500;

const attending = (): boolean => document.hasFocus() && document.visibilityState === "visible";

/** An item of a list, as its point is written. */
export interface SeenItem {
  id: string;
  at: string;
}

/** Waits `SEEN_MS` while `still()` holds and the window is attended, then runs `then`. */
function useAttention() {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (still: () => boolean, then: () => void) => {
    clearTimeout(timer.current);
    if (!attending() || !still()) return;
    timer.current = setTimeout(() => {
      if (attending() && still()) then();
    }, SEEN_MS);
  };
}

/** Reads `place` through the newest of `items` (oldest first) whose bottom
 *  has shown in `root`. Items are the elements in it with a
 *  `data-message-id`; `items` should be stable between changes. */
export function useSeen(place: Place | null, root: RefObject<HTMLElement | null>, items: readonly SeenItem[], { enabled }: { enabled: boolean }) {
  const key = place && placeKey(place);
  const where = useRef(place);
  where.current = place;
  const wait = useAttention();
  const waitRef = useRef(wait);
  waitRef.current = wait;
  useEffect(() => {
    const el = root.current;
    if (!key || !enabled || !el || !items.length || typeof IntersectionObserver === "undefined") return;
    const order = new Map(items.map((it, i) => [it.id, i]));
    const showing = new Set<string>();
    const newest = (): SeenItem | null => {
      let best = -1;
      for (const id of showing) best = Math.max(best, order.get(id) ?? -1);
      return best < 0 ? null : items[best]!;
    };
    const check = () => {
      const item = newest();
      if (!item) return;
      waitRef.current(
        () => showing.has(item.id),
        () => where.current && void advance(where.current, { at: item.at, message: item.id }),
      );
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.messageId;
          if (!id) continue;
          const bottom = e.rootBounds ? e.boundingClientRect.bottom <= e.rootBounds.bottom + 1 : e.intersectionRatio >= 1;
          if (e.isIntersecting && bottom) showing.add(id);
          else showing.delete(id);
        }
        check();
      },
      { root: el, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const node of el.querySelectorAll<HTMLElement>("[data-message-id]")) if (order.has(node.dataset.messageId!)) io.observe(node);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      io.disconnect();
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [key, enabled, items, root]);
}

/** Reads `place` through `point` once half of `ref`'s element has shown. */
export function useSeenWhole(place: Place | null, point: ReadPoint | null, ref: RefObject<HTMLElement | null>, { enabled }: { enabled: boolean }) {
  const key = place && placeKey(place);
  const where = useRef(place);
  where.current = place;
  const wait = useAttention();
  const waitRef = useRef(wait);
  waitRef.current = wait;
  const at = point?.at;
  const message = point?.message ?? null;
  useEffect(() => {
    const el = ref.current;
    if (!key || !enabled || !el || !at || typeof IntersectionObserver === "undefined") return;
    let half = false;
    const check = () =>
      waitRef.current(
        () => half,
        () => where.current && void advance(where.current, { at, message }),
      );
    const io = new IntersectionObserver(
      (entries) => {
        half = entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.5);
        check();
      },
      { threshold: [0, 0.5, 1] },
    );
    io.observe(el);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      io.disconnect();
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [key, enabled, at, message, ref]);
}

/** A session's card or pane: what it did since it was last seen is read
 *  once it has shown. */
export function useSeenSession(session: string | null | undefined, ref: RefObject<HTMLElement | null>, { enabled }: { enabled: boolean }) {
  const since = useUnread((s) => (session ? s.local?.sessions.find((u) => u.id === session)?.since : undefined));
  useSeenWhole(session ? { kind: "session", session } : null, since ? { at: since, message: null } : null, ref, { enabled });
}
