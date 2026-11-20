import { useEffect, type RefObject } from "react";
import { create } from "zustand";

/** The DMs this window shows (Rooms, grid panes, the side panel), by agent
 *  key, with their roots, newest focus last: what "talk here" means. */
const shown = new Map<string, Set<HTMLElement>>();
let recent: string[] = [];

/** The agents whose DM is shown, for what follows it. */
const useShown = create<Record<string, true>>(() => ({}));

const publish = () => useShown.setState(Object.fromEntries([...shown.keys()].map((a) => [a, true] as const)), true);

/** Whether `agent`'s DM is shown in this window, as it changes. */
export const useDmShown = (agent: string | null): boolean => useShown((s) => !!agent && !!s[agent]);

const touch = (agent: string) => {
  recent = [...recent.filter((a) => a !== agent), agent];
};

/** The DM a DM shortcut acts on: the one with focus, else the one most
 *  recently focused that's still shown, else none. */
export const targetDm = (active: Element | null = document.activeElement): string | null => {
  for (const [agent, roots] of shown) for (const root of roots) if (active && root.contains(active)) return agent;
  return [...recent].reverse().find((a) => shown.has(a)) ?? null;
};

/** Whether `agent`'s DM is shown in this window. */
export const isShown = (agent: string): boolean => shown.has(agent);

/** Says `agent`'s DM is shown at `root` while mounted, and which DM was
 *  focused last. */
export function useDmPresence(agent: string | null, root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!agent || !el) return;
    const roots = shown.get(agent) ?? new Set<HTMLElement>();
    roots.add(el);
    shown.set(agent, roots);
    if (roots.size === 1) publish();
    if (el.contains(document.activeElement)) touch(agent);
    const focused = () => touch(agent);
    el.addEventListener("focusin", focused);
    el.addEventListener("pointerdown", focused);
    return () => {
      el.removeEventListener("focusin", focused);
      el.removeEventListener("pointerdown", focused);
      roots.delete(el);
      if (roots.size) return;
      shown.delete(agent);
      publish();
      // Moving a pane remounts its DM at once; only a DM that stays gone
      // stops being the one focused last.
      queueMicrotask(() => {
        if (!shown.has(agent)) recent = recent.filter((a) => a !== agent);
      });
    };
  }, [agent, root]);
}

/** Forgets every DM (tests). */
export const resetShown = (): void => {
  shown.clear();
  recent = [];
  publish();
};
