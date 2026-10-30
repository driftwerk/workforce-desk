import { BUSY, Conversation, type ConversationState, type Turn } from "../chat/conversation";
import { readConversation } from "../chat/history";
import { useChat } from "../chat/store";
import { FEATURES, type Attachment, type DeskSpeaker, type DeskTurn, type HubAccount, type PermissionChoice } from "../chat/types";
import type { DeskHub } from "../hub/client";
import { useDesk, type RoomDraft } from "../hub/store";
import type { Room, RoomMemberRef, RoomMessage } from "../hub/types";
import { Drainer, sourceKey } from "../hubs/drain";
import { closeConversation } from "../hubs/surface";
import { deskState } from "../restore/boot";
import { uploadAll } from "../attachments/upload";
import { backoff } from "../hub/socket";
import { resolveMentions } from "./mentions";
import { ROOMS_PREFIX } from "./order";
import { addressees, contextFor, MAX_HOPS, memberKey, memberOf, relay, roomChannel } from "./routing";
import { newestRun, ofPlace, placeKey } from "./window";

// Asking a room's members. Each member answers on a conversation of its own
// for the room (`room.channel` on its hub), one ask at a time across the
// room's threads: an ask for another thread waits for the live one to end,
// so the hub never steers an answer across threads. While it answers, its
// draft shows in the thread it was asked in; once the turn ends, the hub's
// saved copy is drained into the room, so an answer is posted exactly once.

/** One thing a member was asked. */
interface Ask {
  id: string;
  roomId: string;
  member: RoomMemberRef;
  threadId: string | null;
  hop: number;
  text: string;
  speaker: DeskSpeaker;
  /** The room message it answers. */
  message: string;
  attachments: Attachment[];
  /** The ref its turn's frames carry; null on a hub that sends none. */
  ref: string | null;
  replyId: string | null;
  sentAt: number;
  /** How many times the hub has refused it as busy since it was asked. */
  refusals: number;
  /** The room messages of later asks its live turn took in, oldest first:
   *  they die with it when it's stopped. */
  took: string[];
  /** `sending`: waiting for its member's conversation to take it; `held`:
   *  failed or interrupted, until it is asked again or let be. */
  state: "queued" | "sending" | "sent" | "settling" | "held";
}

/** A member's conversation for one room, and the account it was opened
 *  with: a hub paired again is spoken to anew. */
interface Line {
  convo: Conversation;
  hub: HubAccount;
  /** Asks absorbed into a live turn so far, as the hub said. */
  absorbed: number;
  connected: boolean;
  /** When its socket last dropped. */
  droppedAt: number;
}

/** How long a reconnected conversation is given to say a turn is still
 *  going before Desk looks for its answer. */
export const RECONNECT_GRACE_MS = 2_000;
/** How long an ask waits for its member's conversation to open. */
const SEND_TRIES = 60;
const SEND_RETRY_MS = 250;

const lines = new Map<string, Line>();
const asks = new Map<string, Ask>();

const lineKey = (room: Pick<Room, "channel" | "slug">, m: RoomMemberRef) => `${memberKey(m)}#${roomChannel(room)}`;
const lineOf = (a: Ask): string | null => {
  const room = useDesk.getState().rooms[a.roomId];
  return room ? lineKey(room, a.member) : null;
};

const hubFor = (id: string): HubAccount | undefined => useChat.getState().hubs.find((h) => h.id === id);

const displayName = (m: RoomMemberRef): string =>
  useChat.getState().roster.find((a) => a.hubId === m.hub && a.id === m.agent)?.name ?? m.agent;

/** Who wrote a room message, as the members are told it. */
const nameOf = (author: string): string => {
  if (author === "you") return useChat.getState().me.local?.name ?? "The person you work for";
  if (author === "desk") return "Desk";
  const [hub, agent] = author.split("/");
  return `${displayName({ hub: hub ?? "", agent: agent ?? author })} (agent)`;
};

const failed = (e: unknown) => useDesk.getState().fail(e);

const draftOf = (a: Ask, patch: Partial<RoomDraft> = {}): RoomDraft => {
  const was = useDesk.getState().roomDrafts[a.roomId]?.find((d) => d.id === a.id);
  const next: RoomDraft = {
    id: a.id,
    member: memberKey(a.member),
    threadId: a.threadId,
    asked: a.message,
    since: a.sentAt || Date.now(),
    text: "",
    working: null,
    tools: [],
    attachments: [],
    prompts: [],
    state: "queued",
    ...was,
    ...patch,
    took: a.took.length,
  };
  if (a.sentAt) next.since = a.sentAt;
  if (next.state !== "stalled") delete next.stalledSince;
  else next.stalledSince ??= Date.now();
  return next;
};

const show = (a: Ask, patch: Partial<RoomDraft>) => useDesk.getState().putDraft(a.roomId, draftOf(a, patch));

/** The ask is over: its draft goes, and the member's next ask is sent,
 *  and what it was too busy for elsewhere asked again. */
const done = (a: Ask) => {
  asks.delete(a.id);
  useDesk.getState().dropDraft(a.roomId, a.id);
  const key = lineOf(a);
  if (key) pump(key);
  askBusyAgain(memberKey(a.member));
};

/** Asks again what member `member` was too busy to answer. */
function askBusyAgain(member: string) {
  const keys = new Set([...asks.values()].filter((a) => a.refusals > 0 && a.state === "queued" && memberKey(a.member) === member).map(lineOf));
  for (const key of keys) if (key) pump(key);
}

// A member's DM finishing a turn frees them for what they were too busy for.
useChat.subscribe((s, prev) => {
  if (s.conversations === prev.conversations) return;
  for (const [key, was] of Object.entries(prev.conversations)) if (was.working && !s.conversations[key]?.working) askBusyAgain(key);
});

/** The conversation `m` answers `room` on, opened if need be. */
const lineFor = (room: Room, m: RoomMemberRef): Line | null => {
  const hub = hubFor(m.hub);
  if (!hub) return null;
  const key = lineKey(room, m);
  const had = lines.get(key);
  if (had && had.hub.token === hub.token && had.hub.url === hub.url) return had;
  had?.convo.close();
  const convo: Conversation = new Conversation(
    hub,
    m.agent,
    (state) => heard(key, convo, state),
    roomChannel(room),
    (content) => void legacyAnswer(key, convo, content),
  );
  const line: Line = { hub, absorbed: 0, connected: false, droppedAt: 0, convo };
  lines.set(key, line);
  return line;
};

/** Asks on `key`, oldest first. */
const asksOn = (key: string): Ask[] => [...asks.values()].filter((a) => lineOf(a) === key);

/** Sends the member's next ask, unless one for another thread is live. */
function pump(key: string) {
  const on = asksOn(key);
  const next = on.find((a) => a.state === "queued");
  const live = on.find((a) => a.state === "sending" || a.state === "sent" || a.state === "settling");
  if (!next || (live && live.threadId !== next.threadId)) return;
  send(next);
}

/** What an ask in `thread` of room `roomId` may be told of: the place's
 *  newest unbroken run, and its thread's first message. */
const placeSoFar = (roomId: string, thread: string | null) => {
  const { timelines, windows } = useDesk.getState();
  const timeline = timelines[roomId] ?? [];
  const run = newestRun(ofPlace(timeline, thread), windows[placeKey(roomId, thread)]);
  return thread ? [...timeline.filter((m) => m.id === thread), ...run] : run;
};

/** Sends ask `a` once its member's conversation takes it, on the line its
 *  room has for the member then (one paired again meanwhile is a new one). */
function send(a: Ask) {
  const gone = () => {
    a.state = "held";
    show(a, { state: "failed", error: `${displayName(a.member)} is on a workspace Desk isn’t connected to any more.` });
  };
  const room = useDesk.getState().rooms[a.roomId];
  if (!room || !lineFor(room, a.member)) return gone();
  a.state = "sending";
  show(a, { state: "connecting" });
  const from = a.speaker.kind === "agent" ? a.speaker.name : "you";
  const attempt = (n: number) => {
    if (asks.get(a.id) !== a || a.state !== "sending") return;
    const here = useDesk.getState().rooms[a.roomId];
    const line = here && lineFor(here, a.member);
    if (!here || !line) return gone();
    const turn: DeskTurn = {
      place: { kind: "room", room: here.id, name: here.name, ...(a.threadId ? { thread: a.threadId } : {}) },
      speaker: a.speaker,
      hop: a.hop,
      context: contextFor(placeSoFar(here.id, a.threadId), memberKey(a.member), a.threadId, a.message, nameOf),
      message: a.message,
      spoken: false,
    };
    const sent = line.convo.send(a.text, { turn, legacy: relay(here.slug, from, a.text), attachments: a.attachments });
    if (sent) {
      a.state = "sent";
      a.sentAt = Date.now();
      a.ref = sent.turnRef;
      show(a, { state: "live", working: line.convo.current.working });
    } else if (n < SEND_TRIES) setTimeout(() => attempt(n + 1), SEND_RETRY_MS);
    else {
      a.state = "held";
      show(a, { state: "failed", error: `Couldn’t reach ${displayName(a.member)}.` });
      pump(lineKey(here, a.member));
    }
  };
  attempt(0);
}

/** Asks member `m` of `room` something said in it. */
function ask(room: Room, m: RoomMemberRef, what: Omit<Ask, "id" | "roomId" | "member" | "ref" | "replyId" | "sentAt" | "refusals" | "took" | "state">) {
  const a: Ask = {
    ...what,
    id: crypto.randomUUID(),
    roomId: room.id,
    member: m,
    ref: null,
    replyId: null,
    sentAt: 0,
    refusals: 0,
    took: [],
    state: "queued",
  };
  asks.set(a.id, a);
  show(a, { state: "queued" });
  pump(lineKey(room, m));
}

/** A member's conversation changed: its asks' drafts follow their turns.
 *  One closed since, for a line opened anew, is no longer heard. */
function heard(key: string, convo: Conversation, state: ConversationState) {
  const line = lines.get(key);
  if (line?.convo !== convo) return;
  const reconnected = state.connected && !line.connected;
  if (line.connected && !state.connected) line.droppedAt = Date.now();
  line.connected = state.connected;
  const on = asksOn(key).filter((a) => a.state === "sent");
  if (state.absorbed > line.absorbed) {
    // Taken into the live turn: its answer answers both.
    const unheard = on.filter((a) => a.ref && !state.turns[a.ref]?.acked);
    const into = on.find((a) => a.ref && state.turns[a.ref]?.acked);
    unheard.slice(0, state.absorbed - line.absorbed).forEach((a) => {
      line.convo.forget(a.ref!);
      if (into && !into.took.includes(a.message)) into.took.push(a.message);
      done(a);
    });
    line.absorbed = state.absorbed;
  }
  for (const a of asksOn(key).filter((x) => x.state === "sent")) {
    if (!a.ref) {
      const answer = state.messages.at(-1);
      const text = answer?.role === "assistant" && answer.status === "streaming" ? answer.content : "";
      show(a, { state: state.connected ? "live" : "stalled", working: state.working, text });
      continue;
    }
    const t = state.turns[a.ref];
    if (t) follow(key, a, t, state);
  }
  if (reconnected && line.droppedAt) setTimeout(() => void recheck(key, line.droppedAt), RECONNECT_GRACE_MS);
}

/** Ask `a`'s draft as its turn `t` on line `key` stands. Refused as busy,
 *  it's asked again once the member is done elsewhere, or after a while;
 *  failed, it's held and the member's next ask goes. */
function follow(key: string, a: Ask, t: Turn, state: ConversationState) {
  if (t.replyId) a.replyId = t.replyId;
  const source = t.replyId ? sourceKey(a.member.hub, a.member.agent, t.replyId) : undefined;
  const prompts = state.prompts.filter((p) => p.turnRef === a.ref);
  if (t.state === "failed") {
    const ref = a.ref;
    const busy = t.error === BUSY;
    a.ref = null;
    a.state = busy ? "queued" : "held";
    if (ref) lines.get(key)?.convo.forget(ref);
    if (busy) {
      show(a, { state: "busy", working: null });
      setTimeout(() => pump(key), backoff(a.refusals++));
    } else {
      show(a, { state: "failed", text: t.text, working: null, tools: t.tools, attachments: t.attachments, prompts: [], error: t.error });
      pump(key);
    }
    return;
  }
  show(a, {
    state: t.state === "stalled" ? "stalled" : "live",
    text: t.text,
    working: t.working,
    tools: t.tools,
    attachments: t.attachments,
    prompts,
    ...(source ? { source } : {}),
  });
  if (t.state === "ended") void settle(a, t);
}

/** The turn of `a` ended: its answer is put in the room, from the hub's
 *  saved copy where the hub keeps one for Desk, else from what it said. */
async function settle(a: Ask, t: Turn) {
  a.state = "settling";
  const line = lineOf(a) ? lines.get(lineOf(a)!) : undefined;
  const room = useDesk.getState().rooms[a.roomId];
  const hub = hubFor(a.member.hub);
  if (!t.replyId || !room || !hub || !line) return finish(a);
  try {
    if (line.convo.current.features?.has(FEATURES.deliveries)) await drainer.drain(hub, a.member.agent, roomChannel(room));
    else await postAnswer(room, a, t.text, t.attachments, sourceKey(hub.id, a.member.agent, t.replyId));
  } catch (e) {
    a.state = "held";
    show(a, { state: "failed", working: null, error: `Couldn’t fetch ${displayName(a.member)}’s answer: ${e instanceof Error ? e.message : String(e)}` });
    const key = lineOf(a);
    if (key) pump(key);
    return;
  }
  finish(a);
}

function finish(a: Ask) {
  if (a.ref) {
    const key = lineOf(a);
    if (key) lines.get(key)?.convo.forget(a.ref);
  }
  done(a);
}

/** Keeps an answer in the room, handing it on to whoever it mentions when
 *  it is kept for the first time. */
async function postAnswer(room: Room, a: Ask, content: string, attachments: Attachment[], source?: string) {
  const hub = useDesk.getState().hub;
  if (!hub || (!content.trim() && !attachments.length)) return;
  const posted = await hub.post(room.id, {
    author: memberKey(a.member),
    content,
    threadId: a.threadId,
    hop: a.hop,
    attachments: attachments.map((f) => ({ ...f, hub: a.member.hub, agent: a.member.agent })),
    inReplyTo: a.message,
    ...(source ? { source } : {}),
  });
  useDesk.getState().keep(posted.message, posted.created);
  if (posted.created) handOn(room, a.member, posted.message);
}

/** An answer on a hub that streams no turns: the oldest ask sent is it. */
async function legacyAnswer(key: string, convo: Conversation, content: string) {
  if (lines.get(key)?.convo !== convo || convo.current.features?.has(FEATURES.stream)) return;
  const a = asksOn(key).find((x) => x.state === "sent" && !x.ref);
  const room = a && useDesk.getState().rooms[a.roomId];
  if (!a || !room) return;
  a.state = "settling";
  try {
    await postAnswer(room, a, content, []);
  } catch (e) {
    failed(e);
  }
  done(a);
}

/** Hands an answer on to the members it mentions, one hop further. */
function handOn(room: Room, from: RoomMemberRef, posted: RoomMessage) {
  if (posted.hop >= MAX_HOPS) return;
  const { roster, hubs } = useChat.getState();
  for (const m of addressees(posted.content, room.members, roster, null, memberKey(from), hubs))
    ask(room, m, {
      text: posted.content,
      threadId: posted.threadId,
      hop: posted.hop + 1,
      speaker: { kind: "agent", name: displayName(from) },
      message: posted.id,
      attachments: [],
    });
}

/** A conversation back after dropping at `droppedAt`: a turn it didn't
 *  say is still going ended meanwhile, so its answer is looked for; one
 *  never saved is shown as interrupted, to ask again. */
async function recheck(key: string, droppedAt: number) {
  const line = lines.get(key);
  if (!line) return;
  const stalled = asksOn(key).filter(
    (a) => a.state === "sent" && (a.ref ? line.convo.current.turns[a.ref]?.state === "stalled" : a.sentAt <= droppedAt),
  );
  if (!stalled.length) return;
  const room = useDesk.getState().rooms[stalled[0]!.roomId];
  if (room && line.convo.current.features?.has(FEATURES.deliveries))
    await drainer.drain(line.hub, stalled[0]!.member.agent, roomChannel(room)).catch(() => undefined);
  for (const a of stalled) {
    const draft = useDesk.getState().roomDrafts[a.roomId]?.find((d) => d.id === a.id);
    // Gone: the drain just posted its answer.
    if (!draft) {
      finish(a);
      continue;
    }
    if (a.ref) line.convo.forget(a.ref);
    a.ref = null;
    a.state = "held";
    show(a, { state: "interrupted", working: null });
  }
  pump(key);
}

/** Asks again what an interrupted, failed or stopped draft was asked. A
 *  stopped one that had taken in later asks asks the newest of them, whose
 *  context carries the rest. */
export function retry(roomId: string, draftId: string) {
  const a = asks.get(draftId);
  const room = useDesk.getState().rooms[roomId];
  if (!a || !room) return;
  if (a.ref) lines.get(lineKey(room, a.member))?.convo.forget(a.ref);
  const newest = a.took.at(-1);
  const taken = newest ? useDesk.getState().timelines[roomId]?.find((m) => m.id === newest) : undefined;
  if (taken) {
    a.message = taken.id;
    a.text = taken.content;
    a.hop = taken.author === "you" ? 0 : taken.hop + 1;
  }
  a.took = [];
  a.ref = null;
  a.refusals = 0;
  a.sentAt = 0;
  a.state = "queued";
  show(a, {
    state: "queued",
    asked: a.message,
    since: Date.now(),
    text: "",
    working: null,
    tools: [],
    attachments: [],
    prompts: [],
    error: undefined,
    source: undefined,
  });
  pump(lineKey(room, a.member));
}

/** Stops a live answer: its turn is cancelled, what it said is kept as
 *  stopped, and the member's next ask (another thread's) is sent. */
export function stop(roomId: string, draftId: string): void {
  const a = asks.get(draftId);
  const draft = useDesk.getState().roomDrafts[roomId]?.find((d) => d.id === draftId);
  const key = a && lineOf(a);
  const line = key ? lines.get(key) : undefined;
  if (!a || !key || !line || a.state !== "sent" || draft?.state !== "live") return;
  line.convo.cancel();
  if (a.ref) line.convo.forget(a.ref);
  a.ref = null;
  a.state = "held";
  show(a, { state: "stopped", working: null, prompts: [] });
  // The gateway reads the cancel and waits for the turn to settle before it
  // reads the next frame on this socket, so the next ask goes after it; one
  // still settling is refused as busy and queued again.
  pump(key);
}

/** Takes out an ask that's queued, or still waiting for its member's
 *  conversation to take it; the live one is left alone. */
export function cancelAsk(roomId: string, draftId: string): void {
  const a = asks.get(draftId);
  if (!a || a.roomId !== roomId || (a.state !== "queued" && a.state !== "sending")) return;
  const sending = a.state === "sending";
  const key = lineOf(a);
  asks.delete(a.id);
  useDesk.getState().dropDraft(roomId, a.id);
  // One being sent held its member's turn: the next may go.
  if (sending && key) pump(key);
}

/** Every live answer in the room stopped, and every queued one cancelled,
 *  so the queue doesn't start the next the moment one ends. */
export function stopAll(roomId: string): void {
  // Queued ones first: stopping a live answer sends its member's next ask.
  for (const a of [...asks.values()]) if (a.roomId === roomId && a.state === "queued") cancelAsk(roomId, a.id);
  for (const a of [...asks.values()]) if (a.roomId === roomId && a.state === "sending") cancelAsk(roomId, a.id);
  const drafts = useDesk.getState().roomDrafts[roomId] ?? [];
  for (const d of drafts) if (d.state === "live") stop(roomId, d.id);
}

/** The live answer focus is nearest: in the open thread when focus is in
 *  it, else the room's newest live one. */
export const stopTarget = (drafts: readonly RoomDraft[], thread: string | null): RoomDraft | null => {
  const live = drafts.filter((d) => d.state === "live");
  return (thread !== null ? live.filter((d) => d.threadId === thread).at(-1) : undefined) ?? live.at(-1) ?? null;
};

// A held ask whose draft went (its answer arrived after all, or the room
// did) is let be.
useDesk.subscribe((s, prev) => {
  if (s.roomDrafts === prev.roomDrafts) return;
  for (const a of [...asks.values()])
    if (a.state === "held" && !s.roomDrafts[a.roomId]?.some((d) => d.id === a.id)) asks.delete(a.id);
});

/** Leaves a failed draft be. */
export function dismiss(roomId: string, draftId: string) {
  const a = asks.get(draftId);
  if (a) done(a);
  else useDesk.getState().dropDraft(roomId, draftId);
}

/** Answers the permission prompt a draft shows. */
export function answerPrompt(roomId: string, draftId: string, requestId: string, choice: PermissionChoice): boolean {
  const a = asks.get(draftId);
  const room = useDesk.getState().rooms[roomId];
  return !!(a && room && lines.get(lineKey(room, a.member))?.convo.answer(requestId, choice));
}

// ── Draining ──────────────────────────────────────────────────────────────

const DELETED_KEY = `${ROOMS_PREFIX}deleted`;
/** How many deleted rooms Desk remembers, to tell their late messages from
 *  another computer's rooms'. */
const DELETED_KEPT = 500;

const deletedRooms = (): ReadonlySet<string> => {
  const v = deskState.get(DELETED_KEY);
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
};

/** The hand-off the answer saved as `messageId` is at: its ask's, while
 *  Desk knows it, else the last, so an answer it can't place starts none. */
const hopOf = (hubId: string, agentId: string, messageId: string): number =>
  [...asks.values()].find((a) => a.member.hub === hubId && a.member.agent === agentId && a.replyId === messageId)?.hop ?? MAX_HOPS;

const roomOfHub = (): DeskHub => {
  const hub = useDesk.getState().hub;
  if (!hub) throw new Error("Desk isn’t connected to its hub.");
  return hub;
};

/** Drains your conversations on every paired hub into this computer's rooms. */
export const drainer = new Drainer({
  read: readConversation,
  post: async (roomId, m) => {
    const posted = await roomOfHub().post(roomId, m);
    useDesk.getState().keep(posted.message, posted.created);
    return posted;
  },
  close: closeConversation,
  dm: (hub, agentId) => void useChat.getState().refreshHistory(`${hub.id}/${agentId}`),
  replied: (room, hub, agentId, posted) => handOn(room, { hub: hub.id, agent: agentId }, posted),
  hopOf,
  rooms: () => useDesk.getState().rooms,
  deleted: deletedRooms,
  cursors: {
    get: (key) => {
      const v = deskState.get(key);
      return typeof v === "string" ? v : undefined;
    },
    set: (key, id) => deskState.set(key, id),
    remove: (key) => deskState.remove(key),
  },
});

// ── Saying something ──────────────────────────────────────────────────────

/** Says who an ambiguous `@name` could be, in plain words. */
const ambiguity = (name: string): string =>
  `More than one of your crew is called @${name}. Pick the one you mean from the list as you type @.`;

/** Brings the crew a message names into the room first, so they hear it
 *  and answer; answers with the room as it now is. */
async function bringIn(desk: DeskHub, room: Room, text: string): Promise<Room> {
  const { roster, hubs } = useChat.getState();
  const { outsiders, ambiguous } = resolveMentions(text, room.members, roster, hubs);
  if (ambiguous.length) throw new Error(ambiguity(ambiguous[0]!));
  if (!outsiders.length) return room;
  const members: RoomMemberRef[] = [...room.members, ...outsiders.map((a) => ({ hub: a.hubId, agent: a.id }))];
  const updated = await desk.updateRoom(room.id, { members });
  // Kept at once, so nothing prunes the new members' conversations before
  // the hub's own room event arrives.
  useDesk.setState((s) => ({ rooms: { ...s.rooms, [updated.id]: updated } }));
  return updated;
}

/** You say something in a room: anyone it names who isn't in the room is
 *  brought in, its files are sent to each member it addresses, it is
 *  kept, then each of them is asked. */
export async function say(room: Room, text: string, threadId: string | null, files: readonly File[] = []): Promise<void> {
  const hub = useDesk.getState().hub;
  if (!hub || (!text.trim() && !files.length)) return;
  // What you say shows where you are, after the newest; an ask is told of
  // that run only.
  await useDesk
    .getState()
    .toNewest(room.id, threadId)
    .catch(() => undefined);
  const here = await bringIn(hub, room, text);
  const { roster, hubs } = useChat.getState();
  await speak(hub, here, text, threadId, files, addressees(text, here.members, roster, here.defaultMember, undefined, hubs));
}

/** You filled in a form an agent posted in a room: your answer is kept
 *  where the form is, in its thread if it's in one, and asked of the agent
 *  that posted it alone, whatever it mentions. */
export async function answerForm(room: Room, form: RoomMessage, answer: string): Promise<void> {
  const hub = useDesk.getState().hub;
  const author = memberOf(form.author);
  if (!hub || !author) return;
  await speak(hub, room, answer, form.threadId, [], [author], form.id);
}

/** What you said in `here`, kept and asked of `to`, each sent the files. */
async function speak(
  hub: DeskHub,
  here: Room,
  text: string,
  threadId: string | null,
  files: readonly File[],
  to: RoomMemberRef[],
  inReplyTo?: string,
): Promise<void> {
  if (files.length && !to.length) throw new Error("Mention someone in the room to send the files to.");
  const sent = await Promise.all(
    to.map((m) => {
      const account = hubFor(m.hub);
      if (!files.length || !account) return Promise.resolve([]);
      return uploadAll(account, m.agent, roomChannel(here), files).then((up) => up.map((f) => ({ ...f, hub: m.hub, agent: m.agent })));
    }),
  );
  const posted = await hub.post(here.id, {
    author: "you",
    content: text,
    threadId,
    attachments: sent[0] ?? [],
    ...(inReplyTo ? { inReplyTo } : {}),
  });
  useDesk.getState().keep(posted.message, posted.created);
  to.forEach((m, i) =>
    ask(here, m, { text, threadId, hop: 0, speaker: { kind: "person" }, message: posted.message.id, attachments: sent[i] ?? [] }),
  );
}

/** A room you're deleting: each member's hub is told, so what was set up
 *  there reaches your DM instead, and Desk remembers it deleted it. */
export async function closeRoom(room: Room): Promise<void> {
  const before = [...deletedRooms()].filter((id) => id !== room.id);
  deskState.set(DELETED_KEY, [...before.slice(-(DELETED_KEPT - 1)), room.id]);
  await Promise.allSettled(
    room.members.map((m) => {
      const hub = hubFor(m.hub);
      return hub ? closeConversation(hub, m.agent, roomChannel(room)) : Promise.resolve();
    }),
  );
}

/** Closes conversations for rooms or members that are gone, and those on a
 *  hub Desk now reaches with another token or address: what they were
 *  answering goes with them, and what was waiting is asked anew. */
export function prune(rooms: Record<string, Room>, hubs: readonly HubAccount[] = useChat.getState().hubs) {
  const wanted = new Set(Object.values(rooms).flatMap((r) => r.members.map((m) => lineKey(r, m))));
  const closed = new Set<string>();
  for (const [key, line] of lines) {
    const now = hubs.find((h) => h.id === line.hub.id);
    if (wanted.has(key) && now?.token === line.hub.token && now.url === line.hub.url) continue;
    line.convo.close();
    lines.delete(key);
    closed.add(key);
  }
  for (const a of [...asks.values()]) {
    const room = rooms[a.roomId];
    const key = room && lineKey(room, a.member);
    if (key && wanted.has(key) && !(closed.has(key) && a.state !== "queued" && a.state !== "sending")) continue;
    asks.delete(a.id);
    useDesk.getState().dropDraft(a.roomId, a.id);
  }
  for (const key of closed) if (wanted.has(key)) pump(key);
}
