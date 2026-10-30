import { create } from "zustand";
import { Conversation, emptyConversation, type ConversationState } from "./conversation";
import { covered, cursorIn, fetchHistory, prepend } from "./history";
import {
  agentKey,
  FEATURES,
  type Agent,
  type Attachment,
  type ChatMessage,
  type DeskTurn,
  type HubAccount,
  type Me,
  type PermissionChoice,
} from "./types";
import { hubFetch } from "../hub/net";
import { useDesk } from "../hub/store";
import { pictureOf, type Picture } from "../pictures/pictures";

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
  /** You on each hub that knows you (your name there words a suggestion you
   *  said yes to; your picture there shows you in its places), by hub id. */
  me: Record<string, Me>;
  /** Reads who you are on `hubId` again (after your picture changed elsewhere). */
  refreshMe: (hubId: string) => Promise<void>;
  /** Shows the picture an agent or you now have, until the hub is read again. */
  setPicture: (who: { agent: string } | { me: string }, picture: Picture | null) => void;
  conversations: Record<string, ConversationState>;
  /** Each open DM's earlier messages, by agent key. */
  histories: Record<string, History>;
  activeAgent: string | null;
  /** The agent whose DM is open in the side panel beside the Floor. */
  panelAgent: string | null;
  /** What each hub offers Desk, by hub id, as its connections and link say. */
  hubFeatures: Record<string, ReadonlySet<string>>;
  learnFeatures: (hubId: string, features: ReadonlySet<string>) => void;
  /** Messages delivered into DMs you haven't opened since, by agent key. */
  dmUnread: Record<string, number>;
  /** One more message in a DM; none while it is on screen. */
  bumpDm: (key: string) => void;
  seenDm: (key: string) => void;
  setHubs: (hubs: HubAccount[]) => void;
  refreshRoster: () => Promise<void>;
  openDm: (key: string) => void;
  /** Opens the DM that's shown (`activeAgent`, as restored) once its agent
   *  is on the roster; until then it stays chosen. */
  reopenDm: () => void;
  /** Shows agent `key`'s DM in the side panel (null closes it). */
  setPanelAgent: (key: string | null) => void;
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
  send: (key: string, content: string, opts?: SendOptions) => boolean;
  /** Says `content` to an agent without opening their DM (connecting first
   *  if need be); false if it couldn't be sent. */
  sendTo: (key: string, content: string) => Promise<boolean>;
  /** Answers a permission prompt in a DM. */
  answerPrompt: (key: string, requestId: string, choice: PermissionChoice) => boolean;
  cancel: (key: string) => void;
  /** Shows an agent under a new name at once (until the roster is read again). */
  rename: (key: string, name: string) => void;
  /** Closes a removed agent's conversation and leaves it. */
  forget: (key: string) => void;
}

/** How a DM message is sent: spoken (voice), and with files uploaded to the
 *  agent already. */
export interface SendOptions {
  spoken?: boolean;
  attachments?: Attachment[];
}

/** A turn in your DM with an agent. */
export const dmTurn = (spoken = false): DeskTurn => ({
  place: { kind: "dm" },
  speaker: { kind: "person" },
  hop: 0,
  context: [],
  spoken,
});

const live = new Map<string, Conversation>();

/** The hub an agent key (`hub/agent`) is on. */
const hubOf = (key: string): string => key.slice(0, key.indexOf("/"));

interface AgentsResponse {
  agents: { id: string; name?: string | null; model?: string | null; provider?: string | null; default?: boolean; picture?: unknown }[];
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
    picture: pictureOf(a.picture),
  }));
};

/** You on `hub`: null when it doesn't know you, undefined when it
 *  couldn't say (unreachable, or failing). */
const fetchMe = async (hub: HubAccount): Promise<Me | null | undefined> => {
  try {
    const res = await hubFetch(new URL("/api/me", hub.url), { headers: { authorization: `Bearer ${hub.token}` } });
    if (res.status >= 500) return undefined;
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
    const body = (await res.json()) as { id?: unknown; display_name?: unknown; picture?: unknown };
    if (typeof body.id !== "string") return null;
    const name = typeof body.display_name === "string" && body.display_name.trim() ? body.display_name.trim() : null;
    return { id: body.id, name, picture: pictureOf(body.picture) };
  } catch {
    return undefined;
  }
};

/** Each hub's count of pictures you've set there, so a read of you that
 *  began before one doesn't put the old picture back. */
const mySets = new Map<string, number>();

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
  const settling = new Set<string>();
  const convo = new Conversation(hub, agent.id, (c) => {
    const was = useChat.getState().conversations[key];
    useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: c } }));
    if (c.features && c.features !== was?.features) useChat.getState().learnFeatures(hub.id, c.features);
    // Back after the hub restarted: what was said meanwhile is only in its copy.
    if (c.connected && !was?.connected) {
      if (everConnected) void useChat.getState().refreshHistory(key);
      everConnected = true;
    }
    // A turn whose prompt never came live: only the hub's copy has it.
    if (was?.unprompted && !c.unprompted && !c.working && c.connected) void useChat.getState().refreshHistory(key);
    // A turn that ended is in the hub's copy, by the id it was saved under.
    const settled = Object.values(c.turns).filter((t) => (t.state === "ended" || t.state === "failed") && !settling.has(t.ref));
    if (!settled.length) return;
    settled.forEach((t) => settling.add(t.ref));
    void useChat
      .getState()
      .refreshHistory(key)
      .finally(() =>
        settled.forEach((t) => {
          settling.delete(t.ref);
          live.get(key)?.forget(t.ref);
        }),
      );
  });
  live.set(key, convo);
  return true;
};

export const useChat = create<ChatStore>((set, get) => ({
  hubs: [],
  roster: [],
  rosterErrors: {},
  me: {},
  refreshMe: async (hubId) => {
    const hub = get().hubs.find((h) => h.id === hubId);
    if (!hub) return;
    const sets = mySets.get(hubId) ?? 0;
    const me = await fetchMe(hub);
    if (me === undefined || (mySets.get(hubId) ?? 0) !== sets || !get().hubs.some((h) => h.id === hubId)) return;
    set((s) => {
      const { [hubId]: _was, ...others } = s.me;
      return { me: me ? { ...others, [hubId]: me } : others };
    });
  },
  setPicture: (who, picture) => {
    if ("me" in who) mySets.set(who.me, (mySets.get(who.me) ?? 0) + 1);
    set((s) =>
      "agent" in who
        ? { roster: s.roster.map((a) => (agentKey(a) === who.agent ? { ...a, picture } : a)) }
        : s.me[who.me]
          ? { me: { ...s.me, [who.me]: { ...s.me[who.me]!, picture } } }
          : s,
    );
  },
  conversations: {},
  histories: {},
  activeAgent: null,
  panelAgent: null,
  hubFeatures: {},
  learnFeatures: (hubId, features) =>
    set((s) => {
      const had = s.hubFeatures[hubId];
      const same = had && had.size === features.size && [...features].every((f) => had.has(f));
      return same ? s : { hubFeatures: { ...s.hubFeatures, [hubId]: features } };
    }),
  dmUnread: {},
  bumpDm: (key) =>
    set((s) => {
      const desk = useDesk.getState();
      const shown = s.panelAgent === key || (s.activeAgent === key && desk.view === "rooms" && !desk.activeRoom);
      return shown ? s : { dmUnread: { ...s.dmUnread, [key]: (s.dmUnread[key] ?? 0) + 1 } };
    }),
  seenDm: (key) =>
    set((s) => {
      if (!(key in s.dmUnread)) return s;
      const { [key]: _seen, ...dmUnread } = s.dmUnread;
      return { dmUnread };
    }),
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
      // On a hub that isn't paired any more, the side panel's agent is gone.
      panelAgent: hubs.some((h) => s.panelAgent?.startsWith(`${h.id}/`)) ? s.panelAgent : null,
      // Who you are on a hub reached with another token is read again.
      me: Object.fromEntries(
        Object.entries(s.me).filter(([id]) => {
          const now = hubs.find((h) => h.id === id);
          const was = before.find((h) => h.id === id);
          return now && was && now.token === was.token && now.url === was.url;
        }),
      ),
    }));
    for (const key of reopen) ensure(key);
    void get().refreshRoster();
    for (const hub of hubs.filter((h) => !(h.id in get().me))) void get().refreshMe(hub.id);
  },
  refreshRoster: async () => {
    const results = await Promise.allSettled(get().hubs.map(fetchAgents));
    const roster: Agent[] = [];
    const rosterErrors: Record<string, string> = {};
    const read = new Set<string>();
    results.forEach((r, i) => {
      const hub = get().hubs[i]!;
      if (r.status === "fulfilled") {
        roster.push(...r.value);
        read.add(hub.id);
      } else rosterErrors[hub.id] = r.reason instanceof Error ? r.reason.message : String(r.reason);
    });
    // The side panel's agent goes once its hub has been read without it.
    const panel = get().panelAgent;
    const gone = !!panel && read.has(hubOf(panel)) && !roster.some((a) => agentKey(a) === panel);
    set({ roster, rosterErrors, rosterRead: true, ...(gone ? { panelAgent: null } : {}) });
    get().reopenDm();
  },
  reopenDm: () => {
    const key = get().activeAgent;
    if (key && !live.has(key) && get().roster.some((a) => agentKey(a) === key)) get().openDm(key);
  },
  setPanelAgent: (key) => {
    set((s) => (s.panelAgent === key ? s : { panelAgent: key }));
    if (key) get().seenDm(key);
  },
  openDm: (key) => {
    if (!ensure(key)) return;
    set({ activeAgent: key });
    get().seenDm(key);
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
    const first = history && cursorIn(history.messages, "first");
    if (!target || !history || history.state !== "ready" || !history.more || history.earlier === "loading" || !first) return;
    const put = (f: (h: History) => Partial<History>) =>
      set((s) => (s.histories[key] ? { histories: { ...s.histories, [key]: { ...s.histories[key]!, ...f(s.histories[key]!) } } } : {}));
    put(() => ({ earlier: "loading" }));
    try {
      const page = await fetchHistory(target.hub, target.agent.id, first);
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
    const first = cursorIn(was.messages, "first");
    // Earlier pages already read stay above it.
    const reachesBack = !first || page.messages.some((m) => m.id === first);
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
    if (convo) live.get(key)?.drop(covered(page.messages, convo.messages, started, !!convo.features?.has(FEATURES.stream)));
  },
  send: (key, content, opts = {}) =>
    (live.get(key)?.send(content, { turn: dmTurn(opts.spoken), attachments: opts.attachments }) ?? false) !== false,
  answerPrompt: (key, requestId, choice) => live.get(key)?.answer(requestId, choice) ?? false,
  sendTo: (key, content) =>
    new Promise((resolve) => {
      if (!ensure(key)) return resolve(false);
      // The connection opens asynchronously; send once it is up.
      let tries = 0;
      const attempt = () => {
        if (get().send(key, content)) resolve(true);
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
      return {
        conversations,
        histories,
        activeAgent: s.activeAgent === key ? null : s.activeAgent,
        panelAgent: s.panelAgent === key ? null : s.panelAgent,
      };
    });
  },
}));
