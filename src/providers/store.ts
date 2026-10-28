import { useEffect } from "react";
import { create } from "zustand";
import { HubError, type DeskHub } from "../hub/client";
import type { Provider } from "../hub/providers";
import { useDesk } from "../hub/store";
import { plainError } from "../ui/plainError";

interface ProvidersState {
  providers: Provider[];
  /** False until the first answer (or failure). */
  loaded: boolean;
  loading: boolean;
  /** Why the list couldn't be loaded, in plain words. */
  problem: string | null;
  load: (hub: DeskHub) => Promise<void>;
  /** Connects `id` with `fields`; throws a plain-words error. */
  connect: (hub: DeskHub, id: string, fields: Record<string, string>) => Promise<Provider>;
  disconnect: (hub: DeskHub, id: string) => Promise<void>;
}

/** What agents on this Mac can think with, shared by every screen that
 *  shows it. */
export const useProviders = create<ProvidersState>((set, get) => ({
  providers: [],
  loaded: false,
  loading: false,
  problem: null,
  load: async (hub) => {
    set({ loading: true });
    try {
      set({ providers: await hub.providers(), problem: null });
    } catch (e) {
      set({
        problem:
          e instanceof HubError && e.status === 404
            ? "Desk can’t list providers on this Mac yet. Your agents keep running on what they use now."
            : `Desk couldn’t list your providers. ${plainError(e)}`,
      });
    } finally {
      set({ loaded: true, loading: false });
    }
  },
  connect: async (hub, id, fields) => {
    try {
      const next = await hub.connectProvider(id, fields);
      set({ providers: get().providers.map((p) => (p.id === next.id ? next : p)) });
      return next;
    } catch (e) {
      throw new Error(plainError(e));
    }
  },
  disconnect: async (hub, id) => {
    try {
      await hub.disconnectProvider(id);
    } catch (e) {
      throw new Error(plainError(e));
    }
    await get().load(hub);
  },
}));

/** The provider list, loaded once the local hub is there. */
export function useProviderList(): ProvidersState {
  const hub = useDesk((s) => s.hub);
  const state = useProviders();
  useEffect(() => {
    const { loaded, loading, load } = useProviders.getState();
    if (hub && !loaded && !loading) void load(hub);
  }, [hub]);
  return state;
}
