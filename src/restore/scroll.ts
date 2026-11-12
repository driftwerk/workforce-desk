import { useCallback, useEffect, useRef, useState } from "react";
import { useUi, type Anchor } from "../shell/ui";

/** How long after the last scroll its position is kept. */
const SETTLE_MS = 250;
/** How long a saved position waits for content tall enough to reach it. */
const WAIT_MS = 4000;

/** A ref for a scrolling pane whose position is kept as `pane` and put back
 *  when it mounts — once its content (read from the hub, often after it
 *  mounts) is tall enough, and unless it has been scrolled meanwhile. With
 *  `pane` null, nothing is kept (a grid pane's Floor scrolls on its own). */
export function useSavedScroll<T extends HTMLElement>(pane: string | null): (el: T | null) => void {
  const el = useRef<T | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return useCallback(
    (node: T | null) => {
      cleanup.current?.();
      cleanup.current = null;
      el.current = node;
      if (!node || pane === null) return;
      const target = useUi.getState().scroll[pane] ?? 0;
      let restoring = target > 0;
      let frame = 0;
      const started = Date.now();
      const tryRestore = () => {
        if (!restoring) return;
        if (node.scrollHeight - node.clientHeight >= target) {
          node.scrollTop = target;
          restoring = false;
        } else if (Date.now() - started > WAIT_MS) restoring = false;
        else frame = requestAnimationFrame(tryRestore);
      };
      tryRestore();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onScroll = () => {
        // A scroll Desk didn't make ends the wait.
        if (restoring && Math.abs(node.scrollTop - target) > 1) restoring = false;
        clearTimeout(timer);
        timer = setTimeout(() => useUi.getState().setScroll(pane, Math.round(node.scrollTop)), SETTLE_MS);
      };
      node.addEventListener("scroll", onScroll, { passive: true });
      cleanup.current = () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        node.removeEventListener("scroll", onScroll);
      };
    },
    [pane],
  );
}

/** Within this of the newest message counts as at it. */
export const AT_NEWEST_PX = 80;
/** How long a found anchor is held against the pane sticking to its newest
 *  message as the conversation finishes loading. */
const HOLD_MS = 1500;

/** The first message showing in `pane` and how far its top is from the
 *  pane's; null when the pane is at its newest message. */
export const anchorOf = (pane: HTMLElement): Anchor | null => {
  if (pane.scrollHeight - pane.scrollTop - pane.clientHeight <= AT_NEWEST_PX) return null;
  const top = pane.getBoundingClientRect().top;
  for (const el of pane.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top) return { id: el.dataset.messageId!, offset: Math.round(r.top - top) };
  }
  return null;
};

/** Scrolls `pane` so `anchor`'s message is where it was; false while that
 *  message isn't there. */
export const applyAnchor = (pane: HTMLElement, anchor: Anchor): boolean => {
  const el = [...pane.querySelectorAll<HTMLElement>("[data-message-id]")].find((m) => m.dataset.messageId === anchor.id);
  if (!el) return false;
  pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - anchor.offset;
  return true;
};

/** A ref for a conversation's scrolling pane: where it was scrolled up to is
 *  kept as `pane` and put back when it opens; at its newest message, nothing
 *  is kept and it sticks to the newest as before. */
export function useAnchoredScroll<T extends HTMLElement>(pane: string | null): (el: T | null) => void {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return useCallback(
    (node: T | null) => {
      cleanup.current?.();
      cleanup.current = null;
      if (!node || !pane) return;
      const anchor = useUi.getState().anchors[pane];
      let restoring = !!anchor;
      let foundAt = 0;
      const started = Date.now();
      let frame = 0;
      let poll: ReturnType<typeof setTimeout> | undefined;
      const step = () => {
        if (!restoring || !anchor) return;
        const now = Date.now();
        if (applyAnchor(node, anchor)) foundAt ||= now;
        if ((foundAt && now - foundAt > HOLD_MS) || (!foundAt && now - started > WAIT_MS)) {
          restoring = false;
          return;
        }
        frame = requestAnimationFrame(step);
        // A hidden window gets no frames: try on a timer too.
        clearTimeout(poll);
        poll = setTimeout(step, 100);
      };
      step();
      // The person scrolling ends the restore.
      const stop = () => (restoring = false);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onScroll = () => {
        if (restoring) return;
        clearTimeout(timer);
        timer = setTimeout(() => useUi.getState().setAnchor(pane, anchorOf(node)), SETTLE_MS);
      };
      node.addEventListener("wheel", stop, { passive: true });
      node.addEventListener("touchmove", stop, { passive: true });
      node.addEventListener("keydown", stop);
      node.addEventListener("pointerdown", stop);
      node.addEventListener("scroll", onScroll, { passive: true });
      cleanup.current = () => {
        cancelAnimationFrame(frame);
        clearTimeout(poll);
        clearTimeout(timer);
        node.removeEventListener("wheel", stop);
        node.removeEventListener("touchmove", stop);
        node.removeEventListener("keydown", stop);
        node.removeEventListener("pointerdown", stop);
        node.removeEventListener("scroll", onScroll);
      };
    },
    [pane],
  );
}

/** Keeps a conversation's pane at its newest message while it's there:
 *  content growing (a message, a streamed word, an image loading) scrolls
 *  it to the end only when it was at the end before, and only while `live`.
 *  Someone scrolled up is never moved. `pane` is the scrolling element and
 *  `list` what grows inside it; `follow` runs after each render. */
export function useFollowEnd(live: boolean, startAtEnd: boolean) {
  const atEnd = useRef(startAtEnd);
  const liveNow = useRef(live);
  liveNow.current = live;
  const el = useRef<HTMLElement | null>(null);
  const follow = useCallback(() => {
    const node = el.current;
    if (node && atEnd.current && liveNow.current) node.scrollTop = node.scrollHeight;
  }, []);
  const offScroll = useRef<(() => void) | null>(null);
  const pane = useCallback(
    (node: HTMLElement | null) => {
      offScroll.current?.();
      offScroll.current = null;
      el.current = node;
      if (!node) return;
      const onScroll = () => (atEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight <= AT_NEWEST_PX);
      node.addEventListener("scroll", onScroll, { passive: true });
      offScroll.current = () => node.removeEventListener("scroll", onScroll);
      follow();
    },
    [follow],
  );
  const observer = useRef<ResizeObserver | null>(null);
  const list = useCallback(
    (node: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!node || typeof ResizeObserver === "undefined") return;
      observer.current = new ResizeObserver(follow);
      observer.current.observe(node);
    },
    [follow],
  );
  useEffect(
    () => () => {
      offScroll.current?.();
      observer.current?.disconnect();
    },
    [],
  );
  /** Whether the pane is at its newest message now; false lets go of it. */
  const setAtEnd = useCallback((v: boolean) => (atEnd.current = v), []);
  return { pane, list, follow, setAtEnd, atEnd };
}

/** The first message in sight in `pane` and how far its top is from the
 *  pane's, wherever the pane is scrolled. */
const firstInSight = (pane: HTMLElement): Anchor | null => {
  const top = pane.getBoundingClientRect().top;
  for (const el of pane.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top) return { id: el.dataset.messageId!, offset: Math.round(r.top - top) };
  }
  return null;
};

/** The row of message `id` in `pane`. */
const messageRow = (pane: HTMLElement, id: string): HTMLElement | null =>
  pane.querySelector<HTMLElement>(`[data-message-id="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&")}"]`);

/** How far up you scroll to leave the newest message while it grows. */
const LEAVE_PX = 4;

/** Whether `pane` is at (or within reach of) its newest message. */
const nearEnd = (pane: HTMLElement): boolean => pane.scrollHeight - pane.scrollTop - pane.clientHeight <= AT_NEWEST_PX;

/** A chat that stays where you put it. At its newest message, it follows
 *  what arrives and anything that grows. Scrolled up, the message you're
 *  reading keeps its place through any change of height above or below it:
 *  an earlier page landing, a table or image finishing drawing, a reply
 *  streaming, the composer or its queue taking room. Nothing but you moves
 *  it, so the webview's own scroll anchoring (which WebKit lacks) is off
 *  for it in CSS.
 *
 *  Where you were reading is kept as `place` and put back when the chat
 *  opens again, once that message is shown. Until `settled` (the
 *  conversation read), a place not shown yet is waited for; after, the chat
 *  opens at its end. `showAt` opens it at a message instead (the New line). */
export function useStayPut(place: string | null, settled: boolean) {
  const node = useRef<HTMLElement | null>(null);
  const atEnd = useRef(true);
  const held = useRef<Anchor | null>(null);
  const waiting = useRef<Anchor | null>(place ? (useUi.getState().anchors[place] ?? null) : null);
  // What Desk set scrollTop to last: a scroll event at it is Desk's own.
  const ours = useRef<number | null>(null);
  const [away, setAway] = useState(false);
  const settledNow = useRef(settled);
  settledNow.current = settled;

  // Where the pane was last, by Desk or you: a scroll above it is up.
  const lastTop = useRef(0);
  const write = (el: HTMLElement, top: number) => {
    el.scrollTop = top;
    ours.current = el.scrollTop;
    lastTop.current = el.scrollTop;
  };
  const keep = useCallback(() => {
    const el = node.current;
    if (!el) return;
    if (waiting.current) {
      if (messageRow(el, waiting.current.id)) {
        held.current = waiting.current;
        atEnd.current = false;
        waiting.current = null;
        setAway(true);
      } else if (settledNow.current) waiting.current = null;
    }
    if (atEnd.current) return write(el, el.scrollHeight);
    const h = held.current;
    if (!h) return;
    const row = messageRow(el, h.id);
    // Its message gone (a kept copy took its place, under another id): what's
    // in sight now is held from here on.
    if (!row) {
      held.current = firstInSight(el);
      return;
    }
    const off = row.getBoundingClientRect().top - el.getBoundingClientRect().top - h.offset;
    if (Math.abs(off) >= 1) write(el, el.scrollTop + off);
  }, []);

  /** Goes to the newest message, and follows it from there. */
  const toLatest = useCallback(() => {
    atEnd.current = true;
    held.current = null;
    waiting.current = null;
    setAway(false);
    keep();
    if (place) useUi.getState().setAnchor(place, null);
  }, [keep, place]);

  /** Shows message `id` near the top, and holds it there. */
  const showAt = useCallback(
    (id: string, offset = 24) => {
      atEnd.current = false;
      held.current = { id, offset };
      waiting.current = null;
      setAway(true);
      keep();
    },
    [keep],
  );

  const offScroll = useRef<(() => void) | null>(null);
  const pane = useCallback(
    (el: HTMLElement | null) => {
      offScroll.current?.();
      offScroll.current = null;
      node.current = el;
      if (!el) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const save = () => {
        timer = undefined;
        if (place) useUi.getState().setAnchor(place, atEnd.current ? null : held.current);
      };
      const onScroll = () => {
        if (ours.current !== null && Math.abs(el.scrollTop - ours.current) <= 1) return;
        ours.current = null;
        // Yours: where you are now is where to stay. Any scroll up leaves
        // the newest message, however near it; back within reach, you're
        // at it again.
        waiting.current = null;
        const up = el.scrollTop < lastTop.current - LEAVE_PX;
        lastTop.current = el.scrollTop;
        atEnd.current = !up && nearEnd(el);
        held.current = atEnd.current ? null : firstInSight(el);
        setAway(!atEnd.current);
        clearTimeout(timer);
        timer = setTimeout(save, SETTLE_MS);
      };
      const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => keep());
      // The pane itself resizing: the composer, or its queue, taking room.
      ro?.observe(el);
      el.addEventListener("scroll", onScroll, { passive: true });
      offScroll.current = () => {
        // A place not saved yet is saved as the pane goes (another tab).
        if (timer !== undefined) {
          clearTimeout(timer);
          save();
        }
        ro?.disconnect();
        el.removeEventListener("scroll", onScroll);
      };
      keep();
    },
    [keep, place],
  );
  useEffect(() => () => offScroll.current?.(), []);

  /** What grows inside the pane, watched for heights no render changed. */
  const observer = useRef<ResizeObserver | null>(null);
  const list = useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!el || typeof ResizeObserver === "undefined") return;
      observer.current = new ResizeObserver(() => keep());
      observer.current.observe(el);
    },
    [keep],
  );
  useEffect(() => () => observer.current?.disconnect(), []);

  return { pane, list, keep, toLatest, showAt, away };
}
