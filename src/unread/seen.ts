import { useEffect, useRef, useState, type RefObject } from "react";
import { useDesk } from "../hub/store";
import type { ReadPoint } from "../hub/types";
import { later } from "../rooms/time";
import { attending, useDeskFocus } from "./focus";
import { placeKey, type Place } from "./places";
import { advance, laterPoint, pointOf, useReads } from "./reads";
import { useUnread } from "./summary";
import { release, useWatching, watchOff, watchOn } from "./watching";

// The one rule for read: something is read once it has been on screen for
// half a second while its window is visible and has focus (a detached
// grid's while any of Desk's windows has), wherever it shows, or at once when you click, focus or type in it. A place you talk in
// (a room, a thread, a DM, a session) is read whole while it stays on screen,
// however far it's scrolled, and nothing in it is unread while it does; a
// list of others' events (Activity) is read through its newest item whose
// bottom showed; a card or notice once half of it showed.

/** How long something must be on screen to be read. */
export const SEEN_MS = 500;


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

/** Reads `place` while half of `ref`'s element is on screen in this window
 *  with focus: from then it's watched (its badges go at once), read through
 *  `newest` once it has stood half a second or been clicked, focused or
 *  typed in, and read again whenever `newest` moves while it stays. With
 *  `upToNow`, a place whose changes carry no times of their own (a session)
 *  is read through now as well. One marked unread while it shows is left so
 *  until it goes out of sight. */
export function useOnScreen(
  place: Place | null,
  ref: RefObject<HTMLElement | null>,
  newest: ReadPoint | null,
  { enabled, upToNow = false }: { enabled: boolean; upToNow?: boolean },
) {
  const key = place && placeKey(place);
  const where = useRef(place);
  where.current = place;
  /** The place being read, once it has stood long enough. */
  const [reading, setReading] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!key || !enabled || !el || typeof IntersectionObserver === "undefined") return;
    let shown = false;
    let on = false;
    let read = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearTimeout(timer);
      timer = undefined;
      read = false;
      if (on) watchOff(key);
      on = false;
      setReading(null);
    };
    const start = () => {
      clearTimeout(timer);
      timer = undefined;
      read = true;
      setReading(key);
    };
    const look = (now: boolean) => {
      if (!shown || !attending()) return stop();
      if (!on) watchOn(key);
      on = true;
      if (read) return;
      if (now) return start();
      timer ??= setTimeout(() => {
        timer = undefined;
        if (shown && attending()) start();
      }, SEEN_MS);
    };
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries.at(-1);
        if (!e) return;
        shown = e.isIntersecting && e.intersectionRatio >= 0.5;
        if (!shown) release(key);
        look(false);
      },
      { threshold: [0, 0.5, 1] },
    );
    io.observe(el);
    const attended = () => look(false);
    const touched = () => look(true);
    window.addEventListener("focus", attended);
    window.addEventListener("blur", attended);
    document.addEventListener("visibilitychange", attended);
    // Another of Desk's windows gaining or losing focus (see `attending`).
    const unfocused = useDeskFocus.subscribe(attended);
    for (const type of ["pointerdown", "focusin", "keydown"]) el.addEventListener(type, touched, true);
    return () => {
      unfocused();
      stop();
      release(key);
      io.disconnect();
      window.removeEventListener("focus", attended);
      window.removeEventListener("blur", attended);
      document.removeEventListener("visibilitychange", attended);
      for (const type of ["pointerdown", "focusin", "keydown"]) el.removeEventListener(type, touched, true);
    };
  }, [key, enabled, ref]);

  const held = useWatching((s) => !!key && !!s.held[key]);
  // This computer's points are written once they're known, so a place's
  // New line is drawn from where it was read to before it's read again.
  const loaded = useReads((s) => s.loaded);
  const at = newest?.at;
  const message = newest?.message ?? null;
  useEffect(() => {
    const here = where.current;
    if (!key || reading !== key || !here || !at || held || (here.kind !== "dm" && !loaded)) return;
    // Read through now only for something not read yet: not again on every
    // return to it.
    if (upToNow && !laterPoint({ at, message }, pointOf(here))) return;
    void advance(here, { at: upToNow ? later(at, new Date().toISOString()) : at, message });
  }, [key, reading, at, message, held, loaded, upToNow]);
}

/** A session's card or pane, or the terminal a tracked one runs in: read
 *  while it's on screen, through each change of its state and each turn
 *  its hub counts as unread. */
export function useSeenSession(session: string | null | undefined, ref: RefObject<HTMLElement | null>, { enabled }: { enabled: boolean }) {
  const since = useUnread((s) => (session ? s.local?.sessions.find((u) => u.id === session)?.since : undefined));
  const state = useDesk((s) => (session ? s.sessions[session]?.state : undefined));
  const updatedAt = useDesk((s) => (session ? s.sessions[session]?.updatedAt : undefined));
  // When it came into the state it's in, as this window heard it.
  const [changed, setChanged] = useState({ session, state, at: updatedAt });
  if (changed.session !== session || changed.state !== state) setChanged({ session, state, at: updatedAt });
  const at = changed.at ? later(since, changed.at) : since;
  useOnScreen(session ? { kind: "session", session } : null, ref, at ? { at, message: null } : null, { enabled, upToNow: true });
}
