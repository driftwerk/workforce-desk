import { create } from "zustand";
import { Conversation, emptyConversation, type ConversationState } from "./conversation";
import { agentKey, type Agent, type HubAccount } from "./types";

interface ChatStore {
  hubs: HubAccount[];
  roster: Agent[];
  rosterErrors: Record<string, string>;
  conversations: Record<string, ConversationState>;
  activeAgent: string | null;
  setHubs: (hubs: HubAccount[]) => void;
  refreshRoster: () => Promise<void>;
  openDm: (key: string) => void;
  send: (key: string, content: string) => boolean;
  cancel: (key: string) => void;
}

const live = new Map<string, Conversation>();

interface AgentsResponse {
  agents: { id: string; name?: string | null; model?: string | null; provider?: string | null; default?: boolean }[];
}

const fetchAgents = async (hub: HubAccount): Promise<Agent[]> => {
  const res = await fetch(new URL("/api/agents", hub.url), { headers: { authorization: `Bearer ${hub.token}` } });
  if (!res.ok) throw new Error(`${hub.label}: ${res.status === 401 ? "not paired any more" : res.statusText}`);
  const body = (await res.json()) as AgentsResponse;
  return body.agents.map((a) => ({
    hubId: hub.id,
    id: a.id,
    name: a.name || a.id,
    model: a.model ?? null,
    provider: a.provider ?? null,
    isDefault: a.default ?? false,
  }));
};

export const useChat = create<ChatStore>((set, get) => ({
  hubs: [],
  roster: [],
  rosterErrors: {},
  conversations: {},
  activeAgent: null,
  setHubs: (hubs) => {
    for (const [key, c] of live) {
      if (!hubs.some((h) => key.startsWith(`${h.id}/`))) {
        c.close();
        live.delete(key);
      }
    }
    set({ hubs });
    void get().refreshRoster();
  },
  refreshRoster: async () => {
    const results = await Promise.allSettled(get().hubs.map(fetchAgents));
    const roster: Agent[] = [];
    const rosterErrors: Record<string, string> = {};
    results.forEach((r, i) => {
      const hub = get().hubs[i]!;
      if (r.status === "fulfilled") roster.push(...r.value);
      else rosterErrors[hub.id] = r.reason instanceof Error ? r.reason.message : String(r.reason);
    });
    set({ roster, rosterErrors });
  },
  openDm: (key) => {
    if (!live.has(key)) {
      const agent = get().roster.find((a) => agentKey(a) === key);
      const hub = agent && get().hubs.find((h) => h.id === agent.hubId);
      if (!agent || !hub) return;
      set((s) => ({ conversations: { ...s.conversations, [key]: s.conversations[key] ?? emptyConversation() } }));
      live.set(
        key,
        new Conversation(hub, agent.id, (c) => set((s) => ({ conversations: { ...s.conversations, [key]: c } }))),
      );
    }
    set({ activeAgent: key });
  },
  send: (key, content) => live.get(key)?.send(content) ?? false,
  cancel: (key) => live.get(key)?.cancel(),
}));
