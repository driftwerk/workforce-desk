import { create } from "zustand";
import { Conversation, emptyConversation, type ConversationState, type QueuedOutcome } from "./conversation";
import { cursorIn, fetchHistory, prepend } from "./history";
import { settle, type Reading } from "./legacy";
import { keptOf } from "./reconcile";
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
import { HubError } from "../hub/client";
import { deleteMessage } from "./remove";
import { readAround, type Around } from "./search";
import { emptyQueue, heldRetryMs, keepQueue, keptItems, merged, readQueue, withKept, type Queue } from "./queue";
import { deskState } from "../restore/boot";
import { draftKey } from "../restore/drafts";
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
  /** Why each hub's agents couldn't be read, by kind: its token no longer
   *  works (`signedOut`, a 401 — sign in again), or it couldn't be reached. */
  rosterTrouble: Record<string, "signedOut" | "unreachable" | "other">;
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
  /** Agents being built again on their hub (a new name or instructions),
   *  by key: until they serve, the hub doesn't list them, and a roster read
   *  keeps them as they were rather than losing them. */
  settling: Readonly<Record<string, true>>;
  /** Marks agent `key` as being built again (`on`), or done. */
  settle: (key: string, on: boolean) => void;
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
  /** Sends a message that wasn't delivered again, in its place's stead;
   *  false if it couldn't be sent. */
  retry: (key: string, id: string) => boolean;
  /** Takes away a message that wasn't delivered. */
  discard: (key: string, id: string) => void;
  /** Says `content` to an agent without opening their DM (connecting first
   *  if need be); false if it couldn't be sent. */
  sendTo: (key: string, content: string) => Promise<boolean>;
  /** Answers a permission prompt in a DM. */
  answerPrompt: (key: string, requestId: string, choice: PermissionChoice) => boolean;
  /** Stops the agent's turn; what's queued for it then waits, paused. */
  cancel: (key: string) => void;
  /** What's queued in each DM for its agent's next turn, by agent key. */
  queues: Record<string, Queue>;
  /** Queues a message for the agent's next turn; behind a paused queue it
   *  waits with the rest until you send them on. */
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
  /** Marks the queued message being edited (null: none), so nothing goes
   *  until the edit is saved. */
  editingQueued: (key: string, id: string | null) => void;
  /** In each DM, by agent key: the messages an edit set aside (by id or
   *  client id), hidden at once, before the hub's next read leaves them out. */
  setAside: Record<string, string[]>;
  /** Replaces your latest sent message, kept as `replaces`, with `text`,
   *  setting aside it and what followed (`aside`, ids or client ids), and
   *  asks again; null once sent, else why not: the agent is busy, messages
   *  wait in the queue, or the hub can't be reached. */
  editLast: (key: string, replaces: string, aside: string[], text: string) => EditRefusal | null;
  /** By agent key: an edit the hub didn't take, its text to give back to
   *  the composer and the hub's reason. Taken once shown. */
  editBack: Record<string, { text: string; why: string }>;
  /** Clears `editBack` for `key`, once the composer has taken it. */
  tookEditBack: (key: string) => void;
  /** In each DM, by agent key: the stretch of it shown around a search
   *  match that isn't loaded, in place of its newest messages. */
  around: Record<string, Around>;
  /** Shows the DM around message `id`, read from the hub. */
  showAround: (key: string, id: string) => Promise<void>;
  /** Back to the DM's newest messages. */
  leaveAround: (key: string) => void;
  /** In each DM, by agent key: the answers to messages you deleted, until
   *  the hub's next read marks them so. */
  orphans: Record<string, string[]>;
  /** Deletes your message `id` (its kept id; `ids` all it's known by) from
   *  the DM, forgetting the memories `forget`; `replies` are marked as
   *  answering a deleted message. Throws what the hub refused with. */
  deleteMine: (key: string, id: string, ids: string[], replies: string[], forget: string[]) => Promise<void>;
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
  /** The client id to send it under: a message sent again keeps its own,
   *  so a hub that has it already takes it once. */
  message?: string;
}

/** A turn in your DM with an agent. */
/** Why an edit wasn't sent. */
export type EditRefusal = "busy" | "queued" | "offline";

/** Edits sent and not yet settled, by conversation: the turn each went
 *  as, the client id and text it was sent with, and what it set aside. */
const edits = new Map<string, { ref: string; clientId: string; text: string; aside: string[] }[]>();

/** Whether turn `t` of an edit didn't take: refused, or never heard of. */
const refusedTurn = (t: ConversationState["turns"][string] | undefined): boolean =>
  !!t && (t.state === "failed" || (t.state === "ended" && !!t.error) || (t.state === "stalled" && !t.acked));

/** An edit the hub refused (busy, or not your latest message) changed
 *  nothing there: what it set aside comes back, and the hub's copy is read
 *  again, in case an earlier try of it had landed. One that ended is done. */
const settleEdits = (key: string, c: ConversationState) => {
  const pending = edits.get(key);
  if (!pending?.length) return;
  const refused = pending.filter((e) => refusedTurn(c.turns[e.ref]));
  const left = pending.filter((e) => !refused.includes(e) && c.turns[e.ref]?.state !== "ended");
  if (left.length === pending.length) return;
  if (left.length) edits.set(key, left);
  else edits.delete(key);
  if (!refused.length) return;
  const back = new Set(refused.flatMap((e) => e.aside));
  const last = refused.at(-1)!;
  queueMicrotask(() => {
    // The new version never took: it goes, and its words go back to you.
    const convo = live.get(key);
    for (const e of refused) for (const m of useChat.getState().conversations[key]?.messages ?? []) if (m.role === "user" && m.clientId === e.clientId) convo?.remove(m.id);
    const t = c.turns[last.ref];
    useChat.setState((s) => ({
      setAside: { ...s.setAside, [key]: (s.setAside[key] ?? []).filter((id) => !back.has(id)) },
      editBack: { ...s.editBack, [key]: { text: last.text, why: t?.error ?? "" } },
    }));
    void useChat.getState().refreshHistory(key);
  });
};

export const dmTurn = (voice?: DeskVoice): DeskTurn => ({
  place: { kind: "dm" },
  speaker: { kind: "person" },
  hop: 0,
  context: [],
  spoken: voice?.reply === "spoken",
  ...(voice ? { voice } : {}),
});

const live = new Map<string, Conversation>();

/** How long after its answer stopped streaming a turn the hub never said
 *  ended is taken as ended, so a queue can't wait on it for ever. */
export const STREAM_END_GRACE_MS = 10_000;

/** Turns you stopped: the hub says nothing more of them. */
const stopped = new Set<string>();
/** How many times in a row each DM's queue was held back as busy, and when
 *  it may be offered again. */
const held = new Map<string, { times: number; until: number }>();
/** Each DM's pending re-check: a held-back queue's retry, or a turn's grace. */
const later = new Map<string, ReturnType<typeof setTimeout>>();
/** Each DM's watch on its kept queue, for what other windows send. */
const unwatch = new Map<string, () => void>();

/** `q` with the messages of send `ticket` no longer on their way. */
const unmark = (q: Queue, ticket: string): Queue => ({
  ...q,
  items: q.items.map((i) => {
    if (i.sending !== ticket) return i;
    const { sending: _sent, ...rest } = i;
    return rest;
  }),
});

const putQueue = (key: string, f: (q: Queue) => Queue) => {
  const was = useChat.getState().queues[key] ?? emptyQueue();
  const next = f(was);
  if (next === was) return;
  useChat.setState((s) => ({ queues: { ...s.queues, [key]: next } }));
  keepQueue(key, next);
};

const checkAgain = (key: string, ms: number) => {
  clearTimeout(later.get(key));
  later.set(
    key,
    setTimeout(() => {
      later.delete(key);
      drain(key);
    }, ms),
  );
};

/** Whether the agent is still at its turn in conversation `c`: working, or
 *  a turn the hub streams that hasn't said it ended, until a grace after
 *  its last frame (a stopped one ends silently). The composer reads the
 *  same, so a queue that waits always has Stop beside it. */
export const isRunning = (c: ConversationState | undefined, now = Date.now()): boolean =>
  !!c &&
  (!!c.working ||
    (!!c.features?.has(FEATURES.stream) &&
      Object.values(c.turns).some(
        (t) => t.acked && t.state === "live" && !stopped.has(t.ref) && now - (t.heardAt ?? now) < STREAM_END_GRACE_MS,
      )));

/** Sends what's queued for `key`'s agent, as one message, once nothing is
 *  running there, the queue isn't paused or being edited, and nothing of it
 *  is already on its way (from here or another window). What's sent stays
 *  in the queue until the hub takes it. */
const drain = (key: string) => {
  const { queues, conversations } = useChat.getState();
  const q = queues[key];
  const c = conversations[key];
  const convo = live.get(key);
  if (!c || !convo) return;
  const now = Date.now();
  // A turn whose answer has stopped streaming: after the grace it's done,
  // and until then it's looked at again when the grace is up.
  const quiet = c.working ? [] : Object.values(c.turns).filter((t) => t.acked && t.state === "live" && !stopped.has(t.ref));
  for (const t of quiet) if (now - (t.heardAt ?? now) >= STREAM_END_GRACE_MS) convo.lapse(t.ref);
  if (isRunning(useChat.getState().conversations[key], now)) {
    if (quiet.length) checkAgain(key, STREAM_END_GRACE_MS - Math.min(...quiet.map((t) => now - (t.heardAt ?? now))) + 5);
    return;
  }
  // A queued message being edited that's gone (sent or taken out from
  // another window) holds nothing back.
  if (q?.editing && !q.items.some((i) => i.id === q.editing)) return useChat.getState().editingQueued(key, null);
  if (!q?.items.length || q.paused || q.editing || !c.connected) return;
  if (q.items.some((i) => i.sending)) return;
  const wait = held.get(key);
  if (wait && wait.until > now) return checkAgain(key, wait.until - now);
  // Another window may have sent some of it: only what the kept queue
  // still holds, not on its way, goes.
  const kept = deskState.get(draftKey.queue(key));
  const keptIds = kept === undefined ? null : new Set(keptItems(kept).filter((i) => !i.sending).map((i) => i.id));
  const items = q.items.filter((i) => !keptIds || keptIds.has(i.id));
  if (!items.length) return;
  const ticket = crypto.randomUUID();
  const { text, attachments } = merged(items);
  // Marked first, so another window reading the kept queue holds off.
  putQueue(key, (was) => ({ ...was, items: was.items.map((i) => (items.includes(i) ? { ...i, sending: ticket } : i)) }));
  if (!convo.send(text, { turn: dmTurn(), attachments, queued: ticket })) putQueue(key, (was) => unmark(was, ticket));
};

/** What became of queued send `ticket`: taken, it leaves the queue; held
 *  back as busy, it's offered again later, backing off; lost, it waits in
 *  front, paused, for you to send it again. */
const settleQueued = (key: string, ticket: string, outcome: QueuedOutcome) => {
  if (outcome === "taken") {
    held.delete(key);
    putQueue(key, (q) => ({ ...q, items: q.items.filter((i) => i.sending !== ticket) }));
    return;
  }
  putQueue(key, (q) => ({ ...unmark(q, ticket), ...(outcome === "lost" ? { paused: true } : {}) }));
  if (outcome === "busy") {
    const times = (held.get(key)?.times ?? 0) + 1;
    const ms = heldRetryMs(times);
    held.set(key, { times, until: Date.now() + ms });
    checkAgain(key, ms);
  }
};

/** What another window or device did to `key`'s kept queue, shown here. */
const adopt = (key: string, value: unknown) => {
  const was = useChat.getState().queues[key] ?? emptyQueue();
  // What this window has on its way stays marked until the hub answers.
  const mine = new Map(was.items.filter((i) => i.sending).map((i) => [i.id, i.sending!]));
  const items = keptItems(value).map((i) => (!i.sending && mine.has(i.id) ? { ...i, sending: mine.get(i.id)! } : i));
  useChat.setState((s) => ({ queues: { ...s.queues, [key]: { ...was, items } } }));
};

/** The hub an agent key (`hub/agent`) is on. */
const hubOf = (key: string): string => key.slice(0, key.indexOf("/"));

interface AgentsResponse {
  agents: { id: string; name?: string | null; model?: string | null; provider?: string | null; default?: boolean; picture?: unknown }[];
}

const fetchAgents = async (hub: HubAccount): Promise<Agent[]> => {
  const res = await pairedHub(hub).fetch("GET", "/api/agents");
  if (!res.ok) throw new HubError(res.status, `${hub.label}: ${res.status === 401 ? "not paired any more" : res.statusText}`);
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

/** The ids of the agents `hub` serves now, as the roster reads them. */
export const agentIdsOn = async (hub: HubAccount): Promise<string[]> => (await fetchAgents(hub)).map((a) => a.id);

/** A machine's agents aren't listed: its hub runs the sessions placed
 *  there and serves no agents (an older one's Desk agent is removed when
 *  its Desk Helper is updated). */
const machineAgents = async (): Promise<Agent[]> => [];

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
  // Desk's file read after the window opened: what it kept joins the queue.
  void deskState.loaded?.then(() => {
    if (!live.has(key)) return;
    const late = keptItems(deskState.get(draftKey.queue(key)));
    if (late.length) putQueue(key, (q) => withKept(q, late));
  });
  if (!unwatch.has(key)) unwatch.set(key, deskState.watch(draftKey.queue(key), (v) => adopt(key, v)));
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
    settleEdits(key, c);
    // Free again: what's queued goes next.
    queueMicrotask(() => drain(key));
    // A turn whose prompt never came live: only the hub's copy has it.
    if (was?.unprompted && !c.unprompted && !c.working && c.connected) void useChat.getState().refreshHistory(key);
    // A turn that ended is in the hub's copy, by the id it was saved under.
    const settled = Object.values(c.turns).filter((t) => (t.state === "ended" || t.state === "failed") && !settling.has(t.ref));
    if (!settled.length) return;
    settled.forEach((t) => {
      settling.add(t.ref);
      stopped.delete(t.ref);
    });
    void useChat
      .getState()
      .refreshHistory(key)
      .finally(() => {
        // Its turn over and read, a message the hub kept no copy of (a
        // refusal, a command on a hub that doesn't say so) is settled here.
        live.get(key)?.unkeep(settled.flatMap((t) => (t.clientId ? [t.clientId] : [])));
        settled.forEach((t) => {
          settling.delete(t.ref);
          live.get(key)?.forget(t.ref);
        });
      });
  });
  convo.onQueued = (ticket, outcome) => settleQueued(key, ticket, outcome);
  live.set(key, convo);
  return true;
};

/** Gives way, in `key`'s live conversation, to what the hub's page just read
 *  (`kept`) shows, and places what it passed. */
const settleLive = (key: string, kept: ChatMessage[], read: Reading) => {
  const convo = useChat.getState().conversations[key];
  if (!convo?.messages.length) return;
  // A hub with client ids says which live message each kept row is.
  if (convo.features?.has(FEATURES.clientIds)) {
    live.get(key)?.drop(keptOf(kept, convo.messages));
    return;
  }
  // An older hub's copies are matched by what they say and when.
  const now = new Date().toISOString();
  const { ids, anchors, twins } = settle(kept, convo.messages, now, !!convo.features?.has(FEATURES.stream), read);
  live.get(key)?.place(anchors, twins);
  live.get(key)?.drop(ids);
};

/** Each agent's name as its hub last listed it: an optimistic rename in
 *  Desk isn't one until the hub lists it. */
const lastRead = new Map<string, string>();
let renamedTo: (key: string, was: string, now: string) => void = () => {};
/** Calls `f` when the hub lists an agent under a new name. */
export const onRenamed = (f: (key: string, was: string, now: string) => void): void => {
  renamedTo = f;
};

/** The newest `showAround` ask for each DM, by key. */
const arounds = new Map<string, number>();

export const useChat = create<ChatStore>((set, get) => ({
  hubs: [],
  roster: [],
  rosterErrors: {},
  rosterTrouble: {},
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
    const results = await Promise.allSettled(get().hubs.map((h) => (h.machine ? machineAgents() : fetchAgents(h))));
    const roster: Agent[] = [];
    const rosterErrors: Record<string, string> = {};
    const rosterTrouble: Record<string, "signedOut" | "unreachable" | "other"> = {};
    const read = new Set<string>();
    results.forEach((r, i) => {
      const hub = get().hubs[i]!;
      if (r.status === "fulfilled") {
        // An agent being built again is kept, where it was, until it serves.
        const settling = get().settling;
        const listed = new Set(r.value.map(agentKey));
        const fresh = [...r.value];
        get()
          .roster.filter((a) => a.hubId === hub.id)
          .forEach((a, at) => {
            if (settling[agentKey(a)] && !listed.has(agentKey(a))) fresh.splice(Math.min(at, fresh.length), 0, a);
          });
        roster.push(...fresh);
        for (const a of r.value) {
          const key = agentKey(a);
          const was = lastRead.get(key);
          if (was !== undefined && was !== a.name) renamedTo(key, was, a.name);
          lastRead.set(key, a.name);
        }
        read.add(hub.id);
      } else {
        // This computer's hub being down doesn't make its agents vanish: the
        // last list stays (Desk marks it stale) until the hub answers.
        if (hub.local) roster.push(...get().roster.filter((a) => a.hubId === hub.id));
        rosterErrors[hub.id] = r.reason instanceof Error ? r.reason.message : String(r.reason);
        rosterTrouble[hub.id] =
          r.reason instanceof HubError ? (r.reason.status === 401 ? "signedOut" : "other") : r.reason instanceof TypeError || /reach/i.test(rosterErrors[hub.id]!) ? "unreachable" : "other";
      }
    });
    // The side panel's agent goes once its hub has been read without it.
    const panel = get().panelAgent;
    const gone = !!panel && read.has(hubOf(panel)) && !roster.some((a) => agentKey(a) === panel);
    set({ roster, rosterErrors, rosterTrouble, rosterRead: true, ...(gone ? { panelAgent: null } : {}) });
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
    (live.get(key)?.send(content, {
      turn: { ...dmTurn(opts.voice), ...(opts.message ? { message: opts.message } : {}) },
      attachments: opts.attachments,
    }) ?? false) !== false,
  retry: (key, id) => {
    const m = get().conversations[key]?.messages.find((x) => x.id === id && x.undelivered);
    if (!m) return false;
    // Taken away first: the message sent again is the same one, by its id.
    live.get(key)?.remove(id);
    const again = { ...(m.attachments?.length ? { attachments: m.attachments } : {}), ...(m.clientId ? { message: m.clientId } : {}) };
    if (get().send(key, m.content, again)) return true;
    live.get(key)?.restore(m);
    return false;
    return true;
  },
  discard: (key, id) => live.get(key)?.remove(id),
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
  setAside: {},
  orphans: {},
  around: {},
  showAround: async (key, id) => {
    const target = whereIs(get(), key);
    if (!target) return;
    const n = (arounds.get(key) ?? 0) + 1;
    arounds.set(key, n);
    // Only the newest ask is shown, or answers for: a slower, older one
    // resolving (or failing) last would put up a stretch that doesn't hold
    // the match chosen, or say the newer one failed.
    let page;
    try {
      page = await readAround(target.hub, target.agent.id, id);
    } catch (e) {
      if (arounds.get(key) === n) throw e;
      return;
    }
    if (arounds.get(key) !== n) return;
    set((s) => ({ around: { ...s.around, [key]: page } }));
  },
  leaveAround: (key) => {
    arounds.set(key, (arounds.get(key) ?? 0) + 1);
    set((s) => {
      if (!s.around[key]) return {};
      const { [key]: _gone, ...around } = s.around;
      return { around };
    });
  },
  deleteMine: async (key, id, ids, replies, forget) => {
    const target = whereIs(get(), key);
    if (!target) throw new Error("This agent isn’t on a hub Desk is paired with right now.");
    await deleteMessage(target.hub, target.agent.id, id, forget);
    set((s) => ({
      setAside: { ...s.setAside, [key]: [...(s.setAside[key] ?? []), ...ids] },
      orphans: { ...s.orphans, [key]: [...(s.orphans[key] ?? []), ...replies] },
    }));
    // Once the hub's read is in, it says which replies answered it: what
    // was guessed here goes.
    void get()
      .refreshHistory(key)
      .then(() => {
        const kept = new Set((get().histories[key]?.messages ?? []).map((m) => m.id));
        set((s) => ({ orphans: { ...s.orphans, [key]: (s.orphans[key] ?? []).filter((id) => !kept.has(id)) } }));
      });
  },
  editLast: (key, replaces, aside, text) => {
    // Checked again as it goes: the editor may have been open a while.
    if (isRunning(get().conversations[key])) return "busy";
    if (get().queues[key]?.items.length) return "queued";
    const convo = live.get(key);
    const clientId = crypto.randomUUID();
    const sent = text.trim() ? convo?.send(text, { turn: { ...dmTurn(), edit: { replaces }, message: clientId } }) : false;
    if (!sent || !convo) return "offline";
    if (sent.turnRef) edits.set(key, [...(edits.get(key) ?? []), { ref: sent.turnRef, clientId, text, aside }]);
    // The live copies of what's set aside go too: once the hub's read
    // leaves the kept ones out, nothing would hide them.
    const gone = new Set(aside);
    convo.drop(new Set((get().conversations[key]?.messages ?? []).filter((m) => m.clientId !== clientId && (gone.has(m.id) || (m.clientId && gone.has(m.clientId)) || (m.replyTo && gone.has(m.replyTo)))).map((m) => m.id)));
    set((s) => ({ setAside: { ...s.setAside, [key]: [...(s.setAside[key] ?? []), ...aside] } }));
    return null;
  },
  editBack: {},
  tookEditBack: (key) =>
    set((s) => {
      const { [key]: _took, ...editBack } = s.editBack;
      return { editBack };
    }),
  editingQueued: (key, id) => {
    putQueue(key, (q) => {
      if ((q.editing ?? null) === id) return q;
      const { editing: _was, ...rest } = q;
      return id ? { ...rest, editing: id } : rest;
    });
    // The edit is in: what was held for it goes, if it may.
    if (!id) drain(key);
  },
  enqueue: (key, text, attachments) => {
    if (!text.trim() && !attachments?.length) return;
    const item = { id: crypto.randomUUID(), text, ...(attachments?.length ? { attachments } : {}) };
    putQueue(key, (q) => ({ ...q, items: [...q.items, item] }));
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
    const files = item?.attachments ?? [];
    // Files can't join a turn under way; with none running they go now.
    if (!item || item.sending || (files.length && isRunning(get().conversations[key]))) return false;
    if (!get().send(key, item.text, files.length ? { attachments: files } : {})) return false;
    get().removeQueued(key, id);
    return true;
  },
  resumeQueue: (key) => {
    held.delete(key);
    putQueue(key, (q) => (q.paused ? { ...q, paused: false } : q));
    drain(key);
  },
  rename: (key, name) => set((s) => ({ roster: s.roster.map((a) => (agentKey(a) === key ? { ...a, name } : a)) })),
  settling: {},
  settle: (key, on) =>
    set((s) => {
      if (!!s.settling[key] === on) return s;
      const { [key]: _done, ...rest } = s.settling;
      return { settling: on ? { ...rest, [key]: true } : rest };
    }),
  forget: (key) => {
    live.get(key)?.close();
    keepQueue(key, emptyQueue());
    held.delete(key);
    edits.delete(key);
    clearTimeout(later.get(key));
    later.delete(key);
    unwatch.get(key)?.();
    unwatch.delete(key);
    live.delete(key);
    set((s) => {
      const { [key]: _gone, ...conversations } = s.conversations;
      const { [key]: _kept, ...histories } = s.histories;
      const { [key]: _queued, ...queues } = s.queues;
      const { [key]: _aside, ...setAside } = s.setAside;
      const { [key]: _orphans, ...orphans } = s.orphans;
      const { [key]: _around, ...around } = s.around;
      const { [key]: _back, ...editBack } = s.editBack;
      return {
        conversations,
        histories,
        queues,
        setAside,
        orphans,
        around,
        editBack,
        activeAgent: s.activeAgent === key ? null : s.activeAgent,
        panelAgent: s.panelAgent === key ? null : s.panelAgent,
      };
    });
  },
}));
