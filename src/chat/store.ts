import { create } from "zustand";
import { Conversation, emptyConversation, type ConversationState } from "./conversation";
import { covered, fetchHistory, prepend } from "./history";
import { agentKey, type Agent, type ChatMessage, type HubAccount } from "./types";
import { hubFetch } from "../hub/net";

/** What the hub kept of a DM, read when it opens. */
export interface History {
  /** `absent`: the hub doesn't keep DMs for Desk, so there's nothing to read. */
  state: "loading" | "ready" | "absent" | "failed";
  /** Oldest first, with the hub's own ids. */
  messages: ChatMessage[];
  more: boolean;
  /** Reading the page before the first message. */
  earlier: "idle" | "loading" | "failed";
  /** When the latest page was read: live messages after it can't be in it. */
  loadedAt: string | null;
}

const blankHistory = (): History => ({ state: "loading", messages: [], more: false, earlier: "idle", loadedAt: null });

interface ChatStore {
  hubs: HubAccount[];
  roster: Agent[];
  rosterErrors: Record<string, string>;
  /** Your name on each hub that says it (this Mac's), by hub id: how the
   *  hub words a suggestion you said yes to. */
  people: Record<string, string>;
  conversations: Record<string, ConversationState>;
  /** Each open DM's earlier messages, by agent key. */
  histories: Record<string, History>;
  activeAgent: string | null;
  setHubs: (hubs: HubAccount[]) => void;
  refreshRoster: () => Promise<void>;
  openDm: (key: string) => void;
  /** Opens the DM that's shown (`activeAgent`, as restored) once its agent
   *  is on the roster; until then it stays chosen. */
  reopenDm: () => void;
  /** The roster has been read at least once. */
  rosterRead: boolean;
  /** Opens a conversation (and reads what the hub kept of it) without
   *  making it the DM Rooms shows: for a grid pane. */
  watchDm: (key: string) => void;
  /** Reads a DM's latest messages from its hub (again, after a failure). */
  loadHistory: (key: string) => Promise<void>;
  /** Reads the page before the earliest message shown. */
  loadEarlier: (key: string) => Promise<void>;
  /** Reads a DM's latest messages again after a turn the person didn't
   *  start whose prompt only the hub's copy has (a schedule's, or the
   *  overseer's on a hub that doesn't send it live); the live messages that
   *  copy shows give way to it. */
  refreshHistory: (key: string) => Promise<void>;
  send: (key: string, content: string) => boolean;
  /** Says `content` to an agent without opening their DM (connecting first
   *  if need be); false if it couldn't be sent. */
  sendTo: (key: string, content: string) => Promise<boolean>;
  cancel: (key: string) => void;
  /** Shows an agent under a new name at once (until the roster is read again). */
  rename: (key: string, name: string) => void;
  /** Closes a removed agent's conversation and leaves it. */
  forget: (key: string) => void;
}

const live = new Map<string, Conversation>();

interface AgentsResponse {
  agents: { id: string; name?: string | null; model?: string | null; provider?: string | null; default?: boolean }[];
}

const fetchAgents = async (hub: HubAccount): Promise<Agent[]> => {
  const res = await hubFetch(new URL("/api/agents", hub.url), { headers: { authorization: `Bearer ${hub.token}` } });
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

/** Your name on `hub`, if it says. */
const fetchPerson = async (hub: HubAccount): Promise<string | null> => {
  try {
    const res = await hubFetch(new URL("/api/me", hub.url), { headers: { authorization: `Bearer ${hub.token}` } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
    const body = (await res.json()) as { display_name?: unknown };
    return typeof body.display_name === "string" && body.display_name.trim() ? body.display_name.trim() : null;
  } catch {
    return null;
  }
};

const whereIs = (s: Pick<ChatStore, "roster" | "hubs">, key: string): { agent: Agent; hub: HubAccount } | null => {
  const agent = s.roster.find((a) => agentKey(a) === key);
  const hub = agent && s.hubs.find((h) => h.id === agent.hubId);
  return agent && hub ? { agent, hub } : null;
};

/** A live conversation with the agent, opened if it isn't yet; false for
 *  an agent Desk doesn't know. */
const ensure = (key: string): boolean => {
  if (live.has(key)) return true;
  const { roster, hubs } = useChat.getState();
  const agent = roster.find((a) => agentKey(a) === key);
  const hub = agent && hubs.find((h) => h.id === agent.hubId);
  if (!agent || !hub) return false;
  useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: s.conversations[key] ?? emptyConversation() } }));
  let everConnected = false;
  live.set(
    key,
    new Conversation(hub, agent.id, (c) => {
      const was = useChat.getState().conversations[key];
      useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: c } }));
      // Back after the hub restarted: what was said meanwhile is only in its copy.
      if (c.connected && !was?.connected) {
        if (everConnected) void useChat.getState().refreshHistory(key);
        everConnected = true;
      }
      // A turn whose prompt never came live: only the hub's copy has it.
      if (was?.unprompted && !c.unprompted && !c.working && c.connected) void useChat.getState().refreshHistory(key);
    }),
  );
  return true;
};

export const useChat = create<ChatStore>((set, get) => ({
  hubs: [],
  roster: [],
  rosterErrors: {},
  people: {},
  conversations: {},
  histories: {},
  activeAgent: null,
  rosterRead: false,
  setHubs: (hubs) => {
    const before = get().hubs;
    /** Conversations on a hub Desk now reaches with another token (paired
     *  again, as you): reopened with it, under the same keys. */
    const reopen: string[] = [];
    for (const [key, c] of live) {
      const hub = hubs.find((h) => key.startsWith(`${h.id}/`));
      const was = hub && before.find((h) => h.id === hub.id);
      if (!hub || (was && (was.token !== hub.token || was.url !== hub.url))) {
        c.close();
        live.delete(key);
        if (hub) reopen.push(key);
      }
    }
    set((s) => ({
      hubs,
      histories: Object.fromEntries(Object.entries(s.histories).filter(([key]) => hubs.some((h) => key.startsWith(`${h.id}/`)))),
    }));
    for (const key of reopen) ensure(key);
    void get().refreshRoster();
    // The overseer, and so its suggestions, are on this Mac.
    for (const hub of hubs.filter((h) => h.local && !(h.id in get().people)))
      void fetchPerson(hub).then((name) => {
        if (name && get().hubs.some((h) => h.id === hub.id)) set((s) => ({ people: { ...s.people, [hub.id]: name } }));
      });
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
    set({ roster, rosterErrors, rosterRead: true });
    get().reopenDm();
  },
  reopenDm: () => {
    const key = get().activeAgent;
    if (key && !live.has(key) && get().roster.some((a) => agentKey(a) === key)) get().openDm(key);
  },
  openDm: (key) => {
    if (!ensure(key)) return;
    set({ activeAgent: key });
    get().watchDm(key);
  },
  watchDm: (key) => {
    if (!ensure(key)) return;
    if (!get().histories[key] || get().histories[key]!.state === "failed") void get().loadHistory(key);
  },
  loadHistory: async (key) => {
    const target = whereIs(get(), key);
    if (!target) return;
    const putHistory = (h: Partial<History>) =>
      set((s) => ({ histories: { ...s.histories, [key]: { ...(s.histories[key] ?? blankHistory()), ...h } } }));
    putHistory({ state: "loading" });
    try {
      const page = await fetchHistory(target.hub, target.agent.id);
      if (!get().histories[key]) return; // forgotten meanwhile
      putHistory(
        page
          ? { state: "ready", messages: page.messages, more: page.more, earlier: "idle", loadedAt: new Date().toISOString() }
          : { state: "absent", messages: [], more: false },
      );
    } catch {
      if (get().histories[key]) putHistory({ state: "failed" });
    }
  },
  loadEarlier: async (key) => {
    const history = get().histories[key];
    const target = whereIs(get(), key);
    const first = history?.messages[0];
    if (!target || !history || history.state !== "ready" || !history.more || history.earlier === "loading" || !first) return;
    const put = (f: (h: History) => Partial<History>) =>
      set((s) => (s.histories[key] ? { histories: { ...s.histories, [key]: { ...s.histories[key]!, ...f(s.histories[key]!) } } } : {}));
    put(() => ({ earlier: "loading" }));
    try {
      const page = await fetchHistory(target.hub, target.agent.id, first.id);
      put((h) => ({
        earlier: "idle",
        messages: page ? prepend(page.messages, h.messages) : h.messages,
        more: page ? page.more && page.messages.length > 0 : false,
      }));
    } catch {
      put(() => ({ earlier: "failed" }));
    }
  },
  refreshHistory: async (key) => {
    const target = whereIs(get(), key);
    if (!target || get().histories[key]?.state !== "ready") return;
    const started = new Date().toISOString();
    let page;
    try {
      page = await fetchHistory(target.hub, target.agent.id);
    } catch {
      return; // What's shown stays; the next open reads it again.
    }
    const was = get().histories[key];
    if (!page || was?.state !== "ready") return;
    const first = was.messages[0];
    // Earlier pages already read stay above it.
    const reachesBack = !first || page.messages.some((m) => m.id === first.id);
    set((s) => ({
      histories: {
        ...s.histories,
        [key]: {
          ...was,
          messages: prepend(was.messages, page.messages),
          more: reachesBack ? page.more : was.more,
          loadedAt: new Date().toISOString(),
        },
      },
    }));
    const convo = get().conversations[key];
    if (convo) live.get(key)?.drop(covered(page.messages, convo.messages, started));
  },
  send: (key, content) => live.get(key)?.send(content) ?? false,
  sendTo: (key, content) =>
    new Promise((resolve) => {
      if (!ensure(key)) return resolve(false);
      // The connection opens asynchronously; send once it is up.
      let tries = 0;
      const attempt = () => {
        if (live.get(key)?.send(content)) resolve(true);
        else if (++tries < 40) setTimeout(attempt, 150);
        else resolve(false);
      };
      attempt();
    }),
  cancel: (key) => live.get(key)?.cancel(),
  rename: (key, name) => set((s) => ({ roster: s.roster.map((a) => (agentKey(a) === key ? { ...a, name } : a)) })),
  forget: (key) => {
    live.get(key)?.close();
    live.delete(key);
    set((s) => {
      const { [key]: _gone, ...conversations } = s.conversations;
      const { [key]: _kept, ...histories } = s.histories;
      return { conversations, histories, activeAgent: s.activeAgent === key ? null : s.activeAgent };
    });
  },
}));
