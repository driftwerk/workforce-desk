import { useEffect } from "react";
import { create } from "zustand";
import { HubError, type BrowserBackend, type BrowserLive, type DeskHub } from "../hub/client";
import { plainError } from "../ui/plainError";

/** How often Desk asks the hub which browsers are open. */
export const POLL_MS = 3000;

/** What a person calls each browser. */
export const backendLabel = (b: BrowserBackend): string => (b === "chrome" ? "My Chrome" : "Desk’s own browser");

interface BrowserState {
  /** The browsers open now, most recently used first. */
  live: BrowserLive[];
  /** False once the hub said it has no browser yet. */
  supported: boolean;
  stopping: boolean;
  problem: string | null;
  read: (hub: DeskHub) => Promise<void>;
  /** Stop: the turns using the browser end, it closes, and its session
   *  allowances go; one agent's, or every one. */
  stop: (hub: DeskHub, agent?: string) => Promise<void>;
}

export const useBrowser = create<BrowserState>((set, get) => ({
  live: [],
  supported: true,
  stopping: false,
  problem: null,
  read: async (hub) => {
    try {
      set({ live: await hub.browserLive() });
    } catch (e) {
      if (e instanceof HubError && e.status === 404) set({ supported: false, live: [] });
    }
  },
  stop: async (hub, agent) => {
    set({ stopping: true, problem: null });
    try {
      await hub.stopBrowser(agent);
      set({ live: get().live.filter((l) => agent && l.agent !== agent) });
    } catch (e) {
      set({ problem: plainError(e) });
    }
    set({ stopping: false });
    await get().read(hub);
  },
}));

/** Keeps `useBrowser` in step with the hub while Desk is open. */
export function useBrowserWatch(hub: DeskHub | null): void {
  useEffect(() => {
    if (!hub) return;
    useBrowser.setState({ supported: true });
    const tick = () => {
      if (useBrowser.getState().supported) void useBrowser.getState().read(hub);
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, [hub]);
}
