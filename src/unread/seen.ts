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

/** Waits `SEEN_MS` while `still()` holds and the window is attended, then
 *  runs `then`; `cancel` lets go of what's waiting. */
function useAttention() {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const wait = (still: () => boolean, then: () => void) => {
    clearTimeout(timer.current);
    if (!attending() || !still()) return;
    timer.current = setTimeout(() => {
      if (attending() && still()) then();
    }, SEEN_MS);
  };
  const cancel = () => clearTimeout(timer.current);
  return { wait, cancel };
}

/** Reads `place` through the newest of `items` (oldest first) whose bottom
 *  has shown in `root`. Items are the elements in it with a
 *  `data-message-id`; `items` should be stable between changes. */
export function useSeen(place: Place | null, root: RefObject<HTMLElement | null>, items: readonly SeenItem[], { enabled }: { enabled: boolean }) {
  const key = place && placeKey(place);
  const where = useRef(place);
  where.current = place;
  const attention = useAttention();
  const attentionRef = useRef(attention);
  attentionRef.current = attention;
  useEffect(() => {
    const el = root.current;
    // The place this run reads: one shown next waits its own half second.
    const here = where.current;
    if (!key || !here || !enabled || !el || !items.length || typeof IntersectionObserver === "undefined") return;
    const order = new Map(items.map((it, i) => [it.id, i]));
    /** Rows on screen at all, and those whose bottom has shown. */
    const inView = new Map<string, Element>();
    const showing = new Set<string>();
    const newest = (): SeenItem | null => {
      let best = -1;
      for (const id of showing) best = Math.max(best, order.get(id) ?? -1);
      return best < 0 ? null : items[best]!;
    };
    const check = () => {
      const item = newest();
      if (!item) return;
      attentionRef.current.wait(
        () => showing.has(item.id),
        () => void advance(here, { at: item.at, message: item.id }),
      );
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.messageId;
          if (!id) continue;
          const bottom = e.rootBounds ? e.boundingClientRect.bottom <= e.rootBounds.bottom + 1 : e.intersectionRatio >= 1;
          if (e.isIntersecting) inView.set(id, e.target);
          else inView.delete(id);
          if (e.isIntersecting && bottom) showing.add(id);
          else showing.delete(id);
        }
        check();
      },
      { root: el, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    // A row taller than the pane crosses no threshold as its bottom comes
    // into sight, so scrolling looks again at the rows on screen.
    const onScroll = () => {
      if (!inView.size) return;
      const bottom = el.getBoundingClientRect().bottom;
      let more = false;
      for (const [id, row] of inView)
        if (!showing.has(id) && row.getBoundingClientRect().bottom <= bottom + 1) {
          showing.add(id);
          more = true;
        }
      if (more) check();
    };
    for (const node of el.querySelectorAll<HTMLElement>("[data-message-id]")) if (order.has(node.dataset.messageId!)) io.observe(node);
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      attentionRef.current.cancel();
      io.disconnect();
      el.removeEventListener("scroll", onScroll);
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
  const attention = useAttention();
  const attentionRef = useRef(attention);
  attentionRef.current = attention;
  const at = point?.at;
  const message = point?.message ?? null;
  useEffect(() => {
    const el = ref.current;
    const here = where.current;
    if (!key || !here || !enabled || !el || !at || typeof IntersectionObserver === "undefined") return;
    let half = false;
    const check = () =>
      attentionRef.current.wait(
        () => half,
        () => void advance(here, { at, message }),
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
      attentionRef.current.cancel();
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
