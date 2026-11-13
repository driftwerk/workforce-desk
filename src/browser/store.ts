import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useChat } from "../chat/store";
import { browserOf, type BrowserOf } from "../hub/browser";
import { HubError, type BrowserLive } from "../hub/client";
import { plainError } from "../ui/plainError";

/** How often Desk asks the hub which browsers are open. */
export const POLL_MS = 3000;

/** What of the open browsers Desk shows, to tell whether that changed. */
const shownOf = (live: readonly BrowserLive[]): string => JSON.stringify(live.map(({ idle_secs: _idle, ...shown }) => shown));

interface BrowserState {
  /** The browsers open now, most recently used first. */
  live: BrowserLive[];
  /** False once the hub said it has no browser yet. */
  supported: boolean;
  stopping: boolean;
  problem: string | null;
  read: (browser: BrowserOf) => Promise<void>;
  /** Stop: the turns using the browser end, it closes, and its session
   *  allowances go; one agent's, or every one. */
  stop: (browser: BrowserOf, agent?: string) => Promise<void>;
}

export const useBrowser = create<BrowserState>((set, get) => ({
  live: [],
  supported: true,
  stopping: false,
  problem: null,
  read: async (browser) => {
    try {
      const live = await browser.live();
      // Asked every few seconds: the same answer leaves the store as it is.
      // How long each has been idle ticks up every time and nothing shows
      // it, so it doesn't count as a change.
      if (shownOf(live) !== shownOf(get().live)) set({ live });
    } catch (e) {
      if (e instanceof HubError && e.status === 404) set({ supported: false, live: [] });
    }
  },
  stop: async (browser, agent) => {
    set({ stopping: true, problem: null });
    try {
      await browser.stop(agent);
      set({ live: get().live.filter((l) => agent && l.agent !== agent) });
    } catch (e) {
      set({ problem: plainError(e) });
    }
    set({ stopping: false });
    await get().read(browser);
  },
}));

/** Desk's browser on this computer's hub, as the person; null until the
 *  hub is known. */
export function useLocalBrowser(): BrowserOf | null {
  const local = useChat((s) => s.hubs.find((h) => h.local));
  const id = local?.id;
  const url = local?.url;
  return useMemo(() => (local ? browserOf(local) : null), [id, url]);
}

/** Keeps `useBrowser` in step with the hub while Desk is open. */
export function useBrowserWatch(browser: BrowserOf | null): void {
  useEffect(() => {
    if (!browser) return;
    useBrowser.setState({ supported: true });
    const tick = () => {
      if (useBrowser.getState().supported) void useBrowser.getState().read(browser);
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, [browser]);
}
