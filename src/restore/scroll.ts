import { useCallback, useEffect, useRef } from "react";
import { useUi, type Anchor } from "../shell/ui";

/** How long after the last scroll its position is kept. */
const SETTLE_MS = 250;
/** How long a saved position waits for content tall enough to reach it. */
const WAIT_MS = 4000;

/** A ref for a scrolling pane whose position is kept as `pane` and put back
 *  when it mounts — once its content (read from the hub, often after it
 *  mounts) is tall enough, and unless it has been scrolled meanwhile. */
export function useSavedScroll<T extends HTMLElement>(pane: string): (el: T | null) => void {
  const el = useRef<T | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return useCallback(
    (node: T | null) => {
      cleanup.current?.();
      cleanup.current = null;
      el.current = node;
      if (!node) return;
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
const AT_NEWEST_PX = 80;
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
