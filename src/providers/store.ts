import { useEffect } from "react";
import { create } from "zustand";
import { HubError, type DeskHub } from "../hub/client";
import type { Provider } from "../hub/providers";
import { useDesk } from "../hub/store";
import { plainError } from "../ui/plainError";

/** Until the hub lists providers: the two plans, connected when their
 *  login is saved, each on its default model. */
export const fallbackProviders = (vaultPaths: readonly string[]): Provider[] =>
  [
    { id: "claude-code", name: "Claude plan", description: "Your Pro or Max subscription", login: "claude_code/oauth_token" },
    { id: "chatgpt", name: "ChatGPT plan", description: "Your Plus or Pro subscription", login: "codex/auth_json" },
  ].map(({ login, ...p }) => ({
    ...p,
    group: "plan",
    connected: vaultPaths.includes(login),
    connect: { kind: "login", fields: [] },
    models: [{ id: "standard", name: "Default model", description: "The plan’s everyday model", default: true }],
    efforts: [],
    defaultEffort: null,
  }));

interface ProvidersState {
  providers: Provider[];
  /** The hub can't list providers yet: only the plans, from their logins. */
  fallback: boolean;
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

/** What agents on this computer can think with, shared by every screen that
 *  shows it. */
export const useProviders = create<ProvidersState>((set, get) => ({
  providers: [],
  fallback: false,
  loaded: false,
  loading: false,
  problem: null,
  load: async (hub) => {
    set({ loading: true });
    try {
      set({ providers: await hub.providers(), fallback: false, problem: null });
    } catch (e) {
      if (e instanceof HubError && e.status === 404) {
        const paths = await hub.vaultPaths().catch(() => [] as string[]);
        set({ providers: fallbackProviders(paths), fallback: true, problem: null });
      } else if (get().providers.length === 0) set({ problem: `Desk couldn’t list your providers. ${plainError(e)}` });
      // A refresh that fails keeps the list the screen already shows.
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

/** The provider list. A screen that shows it (`fresh`) asks the hub again
 *  each time it opens, keeping the last list on screen meanwhile, so a
 *  provider connected, started or added since then is there. Otherwise it
 *  loads once, and again while it only has the plans' fallback. */
export function useProviderList({ fresh = false }: { fresh?: boolean } = {}): ProvidersState {
  const hub = useDesk((s) => s.hub);
  const state = useProviders();
  useEffect(() => {
    const { loaded, loading, fallback, load } = useProviders.getState();
    if (hub && !loading && (fresh || !loaded || fallback)) void load(hub);
  }, [hub, fresh]);
  return state;
}
