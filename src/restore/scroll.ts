import { useCallback, useEffect, useRef } from "react";
import { useUi } from "../shell/ui";

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
