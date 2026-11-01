import { cursorIn, type HubMessage, type PageAt } from "../chat/history";
import { DESK_DM, type HubAccount } from "../chat/types";
import { HubError } from "../hub/client";
import type { NewRoomMessage, Room, RoomMessage } from "../hub/types";
import { roomChannel } from "../rooms/routing";

// Draining a Desk conversation: everything a hub saved in one of your
// conversations since Desk last looked, read by cursor and put where it
// belongs. An agent's answer or delivery for one of this computer's rooms is
// posted into it, keyed by the message it is so posting it twice is a
// no-op; one for a room this computer deleted goes back to the hub to land in
// your DM; a DM's is read again where it's shown.

/** The key a message an agent said on a hub is posted under, the same one
 *  the hub's own posts into this computer's rooms use. */
export const sourceKey = (hubId: string, agentId: string, messageId: string): string => `${hubId}/${agentId}/${messageId}`;

/** Where Desk keeps how far it has drained a conversation. */
export const DRAIN_PREFIX = "drain.";

export const cursorKey = (hubId: string, agentId: string, channel: string): string => `${DRAIN_PREFIX}${hubId}.${agentId}.${channel}`;

/** What becomes of one message of a conversation. */
export type Placement =
  | { kind: "room"; message: HubMessage; room: Room; threadId: string | null; source: string }
  | { kind: "dm"; message: HubMessage }
  | { kind: "gone"; message: HubMessage }
  | { kind: "skip"; message: HubMessage };

export interface Where {
  hubId: string;
  agentId: string;
  channel: string;
  /** This computer's rooms, by id. */
  rooms: Record<string, Room>;
  /** Rooms this computer deleted. */
  deleted: ReadonlySet<string>;
}

/** Where each of `messages` goes. What you said is in the room already, and
 *  a message for a room this computer doesn't have (another computer's) or that
 *  names no room is left alone. */
export const placements = (messages: readonly HubMessage[], at: Where): Placement[] =>
  messages.map((message): Placement => {
    if (message.from === "user") return { kind: "skip", message };
    if (at.channel === DESK_DM) return { kind: "dm", message };
    const id = message.mark?.room;
    const room = id ? at.rooms[id] : undefined;
    if (room && roomChannel(room) === at.channel)
      return {
        kind: "room",
        message,
        room,
        threadId: message.mark?.thread ?? null,
        source: sourceKey(at.hubId, at.agentId, message.id),
      };
    return id && !room && at.deleted.has(id) ? { kind: "gone", message } : { kind: "skip", message };
  });

/** What draining does to the world, so the plan is tested apart from it. */
export interface DrainDeps {
  read: (hub: HubAccount, agentId: string, at: PageAt) => Promise<{ messages: HubMessage[]; more: boolean } | null>;
  post: (roomId: string, m: NewRoomMessage) => Promise<{ message: RoomMessage; created: boolean }>;
  close: (hub: HubAccount, agentId: string, channel: string, undelivered: string[]) => Promise<void>;
  /** A DM gained `messages`: what shows it reads it again. */
  dm: (hub: HubAccount, agentId: string, messages: HubMessage[]) => void;
  /** An agent's answer was posted into a room for the first time. */
  replied: (room: Room, hub: HubAccount, agentId: string, posted: RoomMessage, said: HubMessage) => void;
  /** The hand-off an answer is at, as far as Desk knows. */
  hopOf: (hubId: string, agentId: string, messageId: string) => number;
  rooms: () => Record<string, Room>;
  deleted: () => ReadonlySet<string>;
  cursors: { get: (key: string) => string | undefined; set: (key: string, id: string) => void; remove: (key: string) => void };
}

/** The most pages one drain reads before it waits for the next signal. */
const MAX_PAGES = 20;

/** How many of the messages drained last Desk keeps to tell of. */
const RECENT = 200;

/** Refusals of one post that a later drain would only meet again (a bad
 *  message, not a member any more, a room that's gone, the loop guard):
 *  the rest of the conversation drains past it. */
const FINAL = new Set([400, 403, 404, 409, 413, 422]);
const refused = (e: unknown): boolean => e instanceof HubError && FINAL.has(e.status);

const sameAccount = (a: HubAccount, b: HubAccount): boolean => a.url === b.url && a.revision === b.revision;

/** A drain of one conversation, and whether it has begun reading. */
interface Queued {
  hub: HubAccount;
  run: Promise<boolean>;
  started: boolean;
}

/** Drains conversations, one drain per conversation at a time; a drain
 *  asked for while another waits to begin is that one. */
export class Drainer {
  private queue = new Map<string, Queued>();
  private recent = new Map<string, HubMessage>();

  constructor(private readonly deps: DrainDeps) {}

  /** Drains `agentId`'s conversation on `channel` of `hub`: true once it
   *  has read and placed all there was, false when some is left for the
   *  next drain. */
  drain(hub: HubAccount, agentId: string, channel: string): Promise<boolean> {
    const key = cursorKey(hub.id, agentId, channel);
    const was = this.queue.get(key);
    if (was && !was.started && sameAccount(was.hub, hub)) return was.run;
    const q: Queued = { hub, started: false, run: Promise.resolve(true) };
    q.run = (was?.run ?? Promise.resolve(true))
      .catch(() => false)
      .then(() => {
        q.started = true;
        return this.run(hub, agentId, channel, key);
      });
    this.queue.set(key, q);
    void q.run.finally(() => this.queue.get(key) === q && this.queue.delete(key)).catch(() => undefined);
    return q.run;
  }

  /** Message `messageId` of `agentId` on `hub`, among those drained lately. */
  said(hubId: string, agentId: string, messageId: string): HubMessage | undefined {
    return this.recent.get(sourceKey(hubId, agentId, messageId));
  }

  private heard(hubId: string, agentId: string, messages: readonly HubMessage[]) {
    for (const m of messages) this.recent.set(sourceKey(hubId, agentId, m.id), m);
    for (const k of this.recent.keys()) {
      if (this.recent.size <= RECENT) break;
      this.recent.delete(k);
    }
  }

  private async run(hub: HubAccount, agentId: string, channel: string, key: string): Promise<boolean> {
    let cursor = this.deps.cursors.get(key);
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const at = await this.page(hub, agentId, channel, cursor, key);
      if (!at.page) return true;
      this.heard(hub.id, agentId, at.page.messages);
      const { done, through } = await this.place(hub, agentId, channel, at.page.messages);
      const placed = at.page.messages.slice(0, at.page.messages.findIndex((m) => m.id === through) + 1);
      const next = cursorIn(placed, "last");
      if (next && next !== cursor) {
        cursor = next;
        this.deps.cursors.set(key, next);
      }
      // Without a cursor the newest page was read, and `more` is what's older.
      if (!done) return false;
      if (!at.forward || !at.page.more || !next) return true;
    }
    return false;
  }

  /** The page after `cursor`; the newest when there is none, or when it
   *  names no message of the conversation any more. */
  private async page(hub: HubAccount, agentId: string, channel: string, cursor: string | undefined, key: string) {
    if (!cursor) return { page: await this.deps.read(hub, agentId, { channel }), forward: false };
    try {
      return { page: await this.deps.read(hub, agentId, { channel, after: cursor }), forward: true };
    } catch (e) {
      if (!(e instanceof HubError && e.status === 400)) throw e;
      this.deps.cursors.remove(key);
      return { page: await this.deps.read(hub, agentId, { channel }), forward: false };
    }
  }

  /** Places a page's messages in order. `through` is the last one placed,
   *  and `done` false when something failed that is tried again next time:
   *  nothing after it is counted as placed. */
  private async place(
    hub: HubAccount,
    agentId: string,
    channel: string,
    messages: HubMessage[],
  ): Promise<{ done: boolean; through: string | undefined }> {
    const plan = placements(messages, { hubId: hub.id, agentId, channel, rooms: this.deps.rooms(), deleted: this.deps.deleted() });
    let through: string | undefined;
    let failed = false;
    for (const p of plan) {
      if (p.kind === "room") {
        try {
          await this.post(hub, agentId, p);
        } catch (e) {
          if (!refused(e)) {
            failed = true;
            break;
          }
          console.warn(`a message for ${p.room.name} wasn't kept:`, e);
        }
      }
      through = p.message.id;
    }
    const placed = plan.slice(0, through === undefined ? 0 : plan.findIndex((p) => p.message.id === through) + 1);
    const dm = placed.filter((p) => p.kind === "dm").map((p) => p.message);
    if (dm.length) this.deps.dm(hub, agentId, dm);
    const gone = placed.filter((p) => p.kind === "gone").map((p) => p.message);
    const ids = gone.flatMap((m) => cursorIn([m], "first") ?? []);
    if (!ids.length) return { done: !failed, through };
    try {
      await this.deps.close(hub, agentId, channel, ids);
      return { done: !failed, through };
    } catch {
      return { done: false, through: messages[messages.indexOf(gone[0]!) - 1]?.id };
    }
  }

  private async post(hub: HubAccount, agentId: string, p: Extract<Placement, { kind: "room" }>): Promise<void> {
    const said = p.message;
    const delivery = said.mark?.delivery;
    const { message, created } = await this.deps.post(p.room.id, {
      author: `${hub.id}/${agentId}`,
      content: said.text ?? said.content ?? "",
      threadId: p.threadId,
      hop: delivery ? 0 : this.deps.hopOf(hub.id, agentId, said.id),
      attachments: (said.attachments ?? []).map((a) => ({ ...a, hub: hub.id, agent: agentId })),
      source: p.source,
      ...(delivery ? { delivery } : {}),
      ...(said.mark?.request_id ? { requestId: said.mark.request_id } : {}),
      ...(said.mark?.in_reply_to ? { inReplyTo: said.mark.in_reply_to } : {}),
      ...(said.mark?.steps?.length && !delivery ? { steps: said.mark.steps } : {}),
    });
    if (created && !delivery) this.deps.replied(p.room, hub, agentId, message, said);
  }
}
