import { create } from "zustand";
import { Conversation, emptyConversation, type ConversationState } from "./conversation";
import { cursorIn, fetchHistory, prepend, settle, type Reading } from "./history";
import {
  agentKey,
  FEATURES,
  type Agent,
  type Attachment,
  type ChatMessage,
  type DeskTurn,
  type DeskVoice,
  type HubAccount,
  type Me,
  type PermissionChoice,
} from "./types";
import { pairedHub } from "../hub/net";
import { emptyQueue, keepQueue, merged, readQueue, type Queue } from "./queue";
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
  /** When the read of the latest page began: live messages sent after it may
   *  not be in it. */
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
  /** Stops the agent's turn; what's queued for it then waits, paused. */
  cancel: (key: string) => void;
  /** What's queued in each DM for its agent's next turn, by agent key. */
  queues: Record<string, Queue>;
  /** Queues a message for the agent's next turn, and sends the queue on if
   *  it was paused. */
  enqueue: (key: string, text: string, attachments?: Attachment[]) => void;
  /** Changes a queued message's text; with none left (and no files), takes
   *  it out. */
  editQueued: (key: string, id: string, text: string) => void;
  removeQueued: (key: string, id: string) => void;
  /** Sends a queued message at once, into the running turn (a message with
   *  files can't join one, so it waits); false if it couldn't be sent. */
  sendQueuedNow: (key: string, id: string) => boolean;
  /** Sends a paused queue on: now if the agent is free, else when it is. */
  resumeQueue: (key: string) => void;
  /** Shows an agent under a new name at once (until the roster is read again). */
  rename: (key: string, name: string) => void;
  /** Closes a removed agent's conversation and leaves it. */
  forget: (key: string) => void;
}

/** How a DM message is sent: said rather than typed (and how it's
 *  answered), and with files uploaded to the agent already. */
export interface SendOptions {
  voice?: DeskVoice;
  attachments?: Attachment[];
}

/** A turn in your DM with an agent. */
export const dmTurn = (voice?: DeskVoice): DeskTurn => ({
  place: { kind: "dm" },
  speaker: { kind: "person" },
  hop: 0,
  context: [],
  spoken: voice?.reply === "spoken",
  ...(voice ? { voice } : {}),
});

const live = new Map<string, Conversation>();

/** How long a queue the hub held back (a turn Desk didn't see is running)
 *  waits before it's offered again. */
export const HELD_RETRY_MS = 3000;

/** Each queued send the hub hasn't settled, by turn ref: its agent and what
 *  it carried, put back if the hub holds it back. */
const inFlight = new Map<string, { key: string; items: Queue["items"] }>();
/** Turns you stopped: the hub says nothing more of them. */
const stopped = new Set<string>();
/** When each DM's held-back queue may be offered again. */
const heldUntil = new Map<string, number>();

const putQueue = (key: string, f: (q: Queue) => Queue) => {
  const was = useChat.getState().queues[key] ?? emptyQueue();
  const next = f(was);
  if (next === was) return;
  useChat.setState((s) => ({ queues: { ...s.queues, [key]: next } }));
  keepQueue(key, next);
};

/** Sends what's queued for `key`'s agent, as one message, once nothing is
 *  running there and the queue isn't paused. */
const drain = (key: string) => {
  const { queues, conversations } = useChat.getState();
  const q = queues[key];
  const c = conversations[key];
  const convo = live.get(key);
  // A turn the hub streams is running until it says it ended, whatever
  // pauses there are between its model calls; a stopped one ends silently.
  const streamed = !!c?.features?.has(FEATURES.stream);
  const running =
    !!c && (!!c.working || (streamed && Object.values(c.turns).some((t) => t.acked && t.state === "live" && !stopped.has(t.ref))));
  if (!q?.items.length || q.paused || !c?.connected || running || !convo) return;
  if ((heldUntil.get(key) ?? 0) > Date.now()) return;
  const { text, attachments } = merged(q.items);
  const sent = convo.send(text, { turn: dmTurn(), attachments, queued: true });
  if (!sent) return;
  heldUntil.delete(key);
  if (sent.turnRef) inFlight.set(sent.turnRef, { key, items: q.items });
  putQueue(key, (was) => ({ ...was, items: was.items.filter((i) => !q.items.includes(i)) }));
};

/** The hub an agent key (`hub/agent`) is on. */
const hubOf = (key: string): string => key.slice(0, key.indexOf("/"));

interface AgentsResponse {
  agents: { id: string; name?: string | null; model?: string | null; provider?: string | null; default?: boolean; picture?: unknown }[];
}

const fetchAgents = async (hub: HubAccount): Promise<Agent[]> => {
  const res = await pairedHub(hub).fetch("GET", "/api/agents");
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
    const res = await pairedHub(hub).fetch("GET", "/api/me");
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

/** Each DM's count of reads of its history begun, and the count of the one
 *  shown, so a read that began before the one shown changes nothing. */
const readsBegun = new Map<string, number>();
const readShown = new Map<string, number>();

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
  const kept = useChat.getState().queues[key] ? null : readQueue(key);
  useChat.setState((s) => ({
    conversations: { ...s.conversations, [key]: s.conversations[key] ?? emptyConversation() },
    ...(kept ? { queues: { ...s.queues, [key]: kept } } : {}),
  }));
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
    // Free again: what's queued goes next.
    queueMicrotask(() => drain(key));
    // A turn whose prompt never came live: only the hub's copy has it.
    if (was?.unprompted && !c.unprompted && !c.working && c.connected) void useChat.getState().refreshHistory(key);
    // A turn that ended is in the hub's copy, by the id it was saved under.
    const settled = Object.values(c.turns).filter((t) => (t.state === "ended" || t.state === "failed") && !settling.has(t.ref));
    if (!settled.length) return;
    settled.forEach((t) => {
      settling.add(t.ref);
      inFlight.delete(t.ref);
      stopped.delete(t.ref);
    });
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
  // A queued send the hub held back goes to the front of the queue again,
  // and is offered once more in a moment.
  convo.onHeld = (ref) => {
    const sent = inFlight.get(ref);
    inFlight.delete(ref);
    if (!sent) return;
    putQueue(key, (q) => ({ ...q, items: [...sent.items, ...q.items] }));
    heldUntil.set(key, Date.now() + HELD_RETRY_MS);
    setTimeout(() => drain(key), HELD_RETRY_MS);
  };
  live.set(key, convo);
  return true;
};

/** Gives way, in `key`'s live conversation, to what the hub's page just read
 *  (`kept`) shows, and places what it passed. */
const settleLive = (key: string, kept: ChatMessage[], read: Reading) => {
  const convo = useChat.getState().conversations[key];
  if (!convo?.messages.length) return;
  const now = new Date().toISOString();
  const { ids, anchors, twins } = settle(kept, convo.messages, now, !!convo.features?.has(FEATURES.stream), read);
  live.get(key)?.place(anchors, twins);
  live.get(key)?.drop(ids);
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
  rosterRead: false,
  setHubs: (hubs) => {
    const before = get().hubs;
    /** Conversations on a hub Desk now reaches with another token (paired
     *  again, as you): reopened with it, under the same keys. */
    const reopen: string[] = [];
    for (const [key, c] of live) {
      const hub = hubs.find((h) => key.startsWith(`${h.id}/`));
      const was = hub && before.find((h) => h.id === hub.id);
      if (!hub || (was && (was.revision !== hub.revision || was.url !== hub.url))) {
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
          return now && was && now.revision === was.revision && now.url === was.url;
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
    // What's sent from here on, the read may not have seen.
    const started = new Date().toISOString();
    try {
      const page = await fetchHistory(target.hub, target.agent.id);
      if (!get().histories[key]) return; // forgotten meanwhile
      putHistory(
        page
          ? { state: "ready", messages: page.messages, more: page.more, earlier: "idle", loadedAt: started }
          : { state: "absent", messages: [], more: false },
      );
      if (page) settleLive(key, page.messages, { began: started, seen: new Set() });
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
    const read = (readsBegun.get(key) ?? 0) + 1;
    readsBegun.set(key, read);
    let page;
    try {
      page = await fetchHistory(target.hub, target.agent.id);
    } catch {
      return; // What's shown stays; the next open reads it again.
    }
    const was = get().histories[key];
    if (!page || was?.state !== "ready") return;
    // One begun before the read shown came back after it: it has nothing newer.
    if (read < (readShown.get(key) ?? 0)) return;
    readShown.set(key, read);
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
          loadedAt: started,
        },
      },
    }));
    settleLive(key, page.messages, { began: started, seen: new Set(was.messages.map((m) => m.id)) });
  },
  send: (key, content, opts = {}) =>
    (live.get(key)?.send(content, { turn: dmTurn(opts.voice), attachments: opts.attachments }) ?? false) !== false,
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
  cancel: (key) => {
    // Paused first, so the turn ending doesn't send the queue on.
    putQueue(key, (q) => (q.items.length && !q.paused ? { ...q, paused: true } : q));
    const c = get().conversations[key];
    for (const t of Object.values(c?.turns ?? {})) if (t.state === "live") stopped.add(t.ref);
    live.get(key)?.cancel();
  },
  queues: {},
  enqueue: (key, text, attachments) => {
    if (!text.trim() && !attachments?.length) return;
    const item = { id: crypto.randomUUID(), text, ...(attachments?.length ? { attachments } : {}) };
    putQueue(key, (q) => ({ items: [...q.items, item], paused: false }));
    drain(key);
  },
  editQueued: (key, id, text) =>
    putQueue(key, (q) => ({
      ...q,
      items: q.items.flatMap((i) => (i.id !== id ? [i] : text.trim() || i.attachments?.length ? [{ ...i, text }] : [])),
    })),
  removeQueued: (key, id) => putQueue(key, (q) => ({ ...q, items: q.items.filter((i) => i.id !== id) })),
  sendQueuedNow: (key, id) => {
    const item = get().queues[key]?.items.find((i) => i.id === id);
    if (!item || item.attachments?.length) return false;
    if (!get().send(key, item.text)) return false;
    get().removeQueued(key, id);
    return true;
  },
  resumeQueue: (key) => {
    putQueue(key, (q) => (q.paused ? { ...q, paused: false } : q));
    drain(key);
  },
  rename: (key, name) => set((s) => ({ roster: s.roster.map((a) => (agentKey(a) === key ? { ...a, name } : a)) })),
  forget: (key) => {
    live.get(key)?.close();
    keepQueue(key, emptyQueue());
    heldUntil.delete(key);
    live.delete(key);
    set((s) => {
      const { [key]: _gone, ...conversations } = s.conversations;
      const { [key]: _kept, ...histories } = s.histories;
      const { [key]: _queued, ...queues } = s.queues;
      return {
        conversations,
        histories,
        queues,
        activeAgent: s.activeAgent === key ? null : s.activeAgent,
        panelAgent: s.panelAgent === key ? null : s.panelAgent,
      };
    });
  },
}));
