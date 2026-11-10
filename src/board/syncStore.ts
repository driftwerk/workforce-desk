import { create } from "zustand";
import { useChat } from "../chat/store";
import type { HubAccount } from "../chat/types";
import { boardSyncOf, syncHubId, type BoardSyncApi } from "../hub/boardSync";
import type { SyncHub, SyncVia } from "../hub/types";

/** This computer's hub, as the person: where a board's sync is asked. */
export const localHubRef = (): HubAccount | undefined => useChat.getState().hubs.find((h) => h.local);

/** The board sync on this computer's hub; null while it isn't known. */
export const localSync = (): BoardSyncApi | null => {
  const h = localHubRef();
  return h ? boardSyncOf(h) : null;
};

interface SyncHubsState {
  /** The hubs boards may sync through, as the local hub keeps them; null
   *  until read (or on a hub without board sync). */
  hubs: SyncHub[] | null;
  load: () => Promise<void>;
}

export const useSyncHubs = create<SyncHubsState>((set) => ({
  hubs: null,
  load: async () => {
    const sync = localSync();
    if (!sync) return;
    try {
      set({ hubs: await sync.hubs() });
    } catch {
      // Kept as last read: an older hub, or the hub away.
    }
  },
}));

/** The name a board's hub goes by: the kept hub's name, else a paired
 *  hub's label, else its id. */
export const hubNameOf = (via: SyncVia, kept: readonly SyncHub[] | null, paired: readonly HubAccount[]): string => {
  if (via.kind === "thisHub") return "This computer";
  return kept?.find((h) => h.id === via.hub)?.name ?? paired.find((h) => !h.local && syncHubId(h.id) === via.hub)?.label ?? via.hub;
};

/** The hubs a board may sync through: every paired hub but this
 *  computer's and the person's machines', each with what the local hub
 *  keeps of it. */
export interface SyncChoice {
  /** The paired hub's id (the native side's), and the sync hub's. */
  paired: string;
  id: string;
  name: string;
  url: string;
  kept: SyncHub | null;
}

export const syncChoices = (paired: readonly HubAccount[], kept: readonly SyncHub[] | null): SyncChoice[] =>
  paired
    .filter((h) => !h.local && !h.machine)
    .map((h) => {
      const id = syncHubId(h.id);
      return { paired: h.id, id, name: h.label, url: h.url, kept: kept?.find((k) => k.id === id) ?? null };
    });
