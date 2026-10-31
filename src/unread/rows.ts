import type { Agent, HubAccount } from "../chat/types";
import type { Brief, Engine, ReadPoint, Room, RoomMessage, Session } from "../hub/types";
import type { ConversationUnread } from "../hubs/surface";
import type { Target } from "../shell/navigate";
import { authorOf } from "../rooms/names";
import { instant, justBefore } from "../rooms/time";
import { plain } from "../ui/plain";
import type { Place } from "./places";
import type { UnreadSummary } from "../hub/types";

// The Unread page's rows: one per place with something unread, what's for
// you before what's only new, then newest first. Each says who and what in
// words, never an id.

/** What a row's mark is drawn from. */
export type RowMark =
  | { kind: "agent"; agent: string; name: string }
  | { kind: "member"; member: string; name: string }
  | { kind: "session"; name: string; engine: Engine }
  | { kind: "room"; name: string }
  | { kind: "desk" };

export interface UnreadRow {
  key: string;
  place: Place;
  urgency: "forYou" | "new";
  /** What's for you, or how many are new. */
  count: number;
  /** When the newest of it came. */
  at: string | null;
  /** What the place is: "Allan", "Atlas launch", "Which branch?". */
  title: string;
  /** Where it is, after the title: "DM · Acme", "Thread", "Session · finished". */
  where: string;
  /** What's in it, in a line: the newest message, the thread's first, the
   *  brief's; who it's from when there's nothing better to say. */
  line: string;
  mark: RowMark;
  /** The room a room's or thread's row is in, which groups them. */
  room?: string;
  /** Where it opens, at its first unread item. */
  open: Target | null;
  /** What Mark read writes. */
  read: ReadPoint;
  /** What Mark unread writes: just before the newest item. */
  unread: ReadPoint | null;
  /** The update's: the version ready. */
  version?: string;
}

/** A text's first line with anything in it, as plain words. */
export const firstLine = (text: string | null | undefined): string =>
  plain(text ?? "")
    .split("\n")
    .find((l) => l.trim())
    ?.trim()
    .slice(0, 200) ?? "";
const before = (at: string | null): ReadPoint | null => (at ? { at: justBefore(at), message: null } : null);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whether `s` reads as an id rather than a name: a uuid, or a long run of
 *  hex. */
export const looksLikeId = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || /^[0-9a-f-]{20,}$/i.test(s);

/** "Allan: what it says", or what it says when there's no one to name. */
const said = (who: string, text: string): string => (text ? (who ? `${who}: ${text}` : text) : "");

export interface RowSources {
  local: UnreadSummary | null;
  dms: Readonly<Record<string, ConversationUnread>>;
  rooms: Readonly<Record<string, Room>>;
  roster: readonly Agent[];
  /** The paired hubs, for where a DM is. */
  hubs?: readonly HubAccount[];
  sessions: Readonly<Record<string, Session>>;
  /** Each session's name as you gave it, by id. */
  sessionNames: Readonly<Record<string, string>>;
  timelines: Readonly<Record<string, readonly RoomMessage[]>>;
  brief: Brief | null;
  /** The version of Desk downloaded and ready, if any. */
  ready: string | null;
  /** When the ready version was first seen here (for its point). */
  readyAt: string;
}

const SESSION_ENDED: Partial<Record<Session["state"], string>> = { done: "finished", interrupted: "interrupted", stopped: "stopped" };

/** Every place with something unread, for you first, then newest first. */
export const unreadRows = (s: RowSources): UnreadRow[] => {
  const rows: UnreadRow[] = [];
  const hubs = s.hubs ?? [];
  const nameOf = (key: string) => {
    const a = authorOf(key, s.roster, hubs);
    return looksLikeId(a.name) ? "" : a.name;
  };
  for (const [key, u] of Object.entries(s.dms)) {
    if (!u.count) continue;
    const [hub = "", ...rest] = key.split("/");
    const agent = rest.join("/");
    const listed = s.roster.find((a) => a.hubId === hub && a.id === agent)?.name;
    const home = hubs.find((h) => h.id === hub)?.label ?? "";
    const name = listed ?? (looksLikeId(agent) ? (home ? `An agent on ${home}` : "An agent") : agent);
    const forYou = u.for_you > 0;
    rows.push({
      key: `dm:${key}`,
      place: { kind: "dm", hub, agent },
      urgency: forYou ? "forYou" : "new",
      count: forYou ? u.for_you : u.count,
      at: u.last?.at ?? null,
      title: name,
      where: home ? `DM · ${home}` : "DM",
      line: `${u.capped ? "100 or more new messages" : plural(u.count, "new message")} from ${listed ?? (looksLikeId(agent) ? "an agent" : agent)}`,
      mark: { kind: "agent", agent: key, name },
      open: { kind: "agent", key },
      read: u.last ? { at: u.last.at, message: u.last.message_id } : { at: new Date(0).toISOString(), message: null },
      unread: before(u.last?.at ?? null),
    });
  }
  for (const r of s.local?.rooms ?? []) {
    const room = s.rooms[r.roomId];
    if (!room) continue;
    const timeline = s.timelines[r.roomId] ?? [];
    if (r.main.count) {
      const first = timeline.find((m) => m.id === r.main.first);
      const newest = [...timeline].reverse().find((m) => !m.threadId && m.author !== "you");
      const shown = first ?? newest;
      rows.push({
        key: `room:${room.id}`,
        place: { kind: "room", room: room.id },
        urgency: r.main.forYou ? "forYou" : "new",
        count: r.main.forYou || r.main.count,
        at: r.main.lastAt,
        title: room.name,
        where: "Room",
        line: (shown && said(nameOf(shown.author), firstLine(shown.content))) || plural(r.main.count, "new message"),
        mark: shown && shown.author !== "you" && shown.author !== "desk" ? { kind: "member", member: shown.author, name: nameOf(shown.author) || room.name } : { kind: "room", name: room.name },
        room: room.id,
        open: { kind: "room", roomId: room.id, threadId: null, ...(r.main.first ? { messageId: r.main.first } : {}) },
        read: { at: r.main.lastAt ?? new Date(0).toISOString(), message: null },
        unread: before(r.main.lastAt),
      });
    }
    for (const t of r.threads) {
      if (!t.unread.count) continue;
      const reply = timeline.find((m) => m.id === t.unread.first);
      const topic = firstLine(t.parent.content);
      rows.push({
        key: `thread:${room.id}/${t.parent.id}`,
        place: { kind: "thread", room: room.id, thread: t.parent.id },
        urgency: t.unread.forYou ? "forYou" : "new",
        count: t.unread.forYou || t.unread.count,
        at: t.unread.lastAt,
        title: topic || "A thread",
        where: `Thread in ${room.name}`,
        line: (reply && said(nameOf(reply.author), firstLine(reply.content))) || `${plural(t.unread.count, "new reply", "new replies")}`,
        mark: { kind: "room", name: room.name },
        room: room.id,
        open: { kind: "room", roomId: room.id, threadId: t.parent.id, ...(t.unread.first ? { messageId: t.unread.first } : {}) },
        read: { at: t.unread.lastAt ?? new Date(0).toISOString(), message: null },
        unread: before(t.unread.lastAt),
      });
    }
  }
  for (const u of s.local?.sessions ?? []) {
    const session = s.sessions[u.id];
    if (!session) continue;
    const name = s.sessionNames[u.id] ?? session.displayName ?? session.name;
    const ended = SESSION_ENDED[session.state] ?? "closed";
    rows.push({
      key: `session:${u.id}`,
      place: { kind: "session", session: u.id },
      urgency: u.urgency === "new" ? "new" : "forYou",
      count: 1,
      at: u.since,
      title: name || "A session",
      where: `Session · ${ended}`,
      line: firstLine(session.lastReply) || firstLine(session.goal) || (session.state === "done" ? "Finished, ready for you to look over." : `It ${ended}.`),
      mark: { kind: "session", name: name || "session", engine: session.engine },
      open: { kind: "session", sessionId: u.id },
      read: { at: u.since, message: null },
      unread: before(u.since),
    });
  }
  // The brief is the overseer's check-in, whose answer is in its DM: while
  // that DM is listed with it, the DM's row is the one row for both.
  const local = hubs.find((h) => h.local);
  const overseer = s.brief && local ? rows.find((r) => r.key === `dm:${local.id}/${s.brief!.by.id}`) : undefined;
  const inDm = !!overseer && !!s.local?.brief && !!overseer.at && instant(overseer.at) >= instant(s.local.brief);
  if (overseer && inDm) overseer.where = `Desk report · ${overseer.where}`;
  if (s.local?.brief && s.brief && !inDm) {
    rows.push({
      key: "brief",
      place: { kind: "brief" },
      urgency: "forYou",
      count: 1,
      at: s.local.brief,
      title: "Desk report",
      where: s.brief.by.name && s.brief.by.name !== "Desk" ? `From ${s.brief.by.name}` : "On the Floor",
      line: firstLine(s.brief.text),
      mark: { kind: "desk" },
      open: null,
      read: { at: s.local.brief, message: null },
      unread: before(s.local.brief),
    });
  }
  if (s.ready && s.local && s.local.update?.message !== s.ready) {
    rows.push({
      key: "update",
      place: { kind: "update" },
      urgency: "new",
      count: 0,
      at: s.readyAt,
      title: `Desk ${s.ready} is ready`,
      where: "Update",
      line: "Installs when you restart; running sessions are resumed after.",
      mark: { kind: "desk" },
      open: null,
      read: { at: s.readyAt, message: s.ready },
      unread: null,
      version: s.ready,
    });
  }
  const t = (r: UnreadRow) => (r.at ? instant(r.at) : 0n);
  return rows.sort((a, b) => (a.urgency !== b.urgency ? (a.urgency === "forYou" ? -1 : 1) : t(a) > t(b) ? -1 : t(a) < t(b) ? 1 : 0));
};

/** Rows, a room's together: a group stands where its first row would. */
export interface RowGroup {
  key: string;
  /** The room, for a room's group of two or more. */
  room: Room | null;
  rows: UnreadRow[];
}

export const groupRows = (rows: readonly UnreadRow[], rooms: Readonly<Record<string, Room>>): RowGroup[] => {
  const groups: RowGroup[] = [];
  const byRoom = new Map<string, RowGroup>();
  for (const r of rows) {
    const g = r.room ? byRoom.get(r.room) : undefined;
    if (g) g.rows.push(r);
    else {
      const made: RowGroup = { key: r.room ? `group:${r.room}` : r.key, room: null, rows: [r] };
      if (r.room) byRoom.set(r.room, made);
      groups.push(made);
    }
  }
  for (const g of groups) if (g.rows.length > 1 && g.rows[0]!.room) g.room = rooms[g.rows[0]!.room] ?? null;
  return groups;
};

/** What's listed, counted: what's for you as a number, a dot for what's
 *  only new. */
export const countRows = (rows: readonly UnreadRow[]): { forYou: number; anyNew: boolean } => ({
  forYou: rows.reduce((n, r) => n + (r.urgency === "forYou" ? r.count : 0), 0),
  anyNew: rows.some((r) => r.urgency === "new"),
});
