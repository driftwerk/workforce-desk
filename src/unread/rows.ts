import type { Agent } from "../chat/types";
import type { Brief, ReadPoint, Room, RoomMessage, Session } from "../hub/types";
import type { ConversationUnread } from "../hubs/surface";
import type { Target } from "../shell/navigate";
import { instant, justBefore } from "../rooms/time";
import type { Place } from "./places";
import type { UnreadSummary } from "../hub/types";

// The Unread page's rows: one per place with something unread, what's for
// you before what's only new, then newest first.

export interface UnreadRow {
  key: string;
  place: Place;
  urgency: "forYou" | "new";
  /** What's for you, or how many are new. */
  count: number;
  /** When the newest of it came. */
  at: string | null;
  /** What the place is: "Allan", "Atlas launch ▸ Which branch?". */
  title: string;
  /** Its first line: the thread's first message, the brief's, the session's state. */
  line: string;
  /** Where it opens, at its first unread item. */
  open: Target | null;
  /** What Mark read writes. */
  read: ReadPoint;
  /** What Mark unread writes: just before the newest item. */
  unread: ReadPoint | null;
  /** The update's: the version ready. */
  version?: string;
}

const firstLine = (text: string | null | undefined): string => (text ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 160) ?? "";
const before = (at: string | null): ReadPoint | null => (at ? { at: justBefore(at), message: null } : null);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export interface RowSources {
  local: UnreadSummary | null;
  dms: Readonly<Record<string, ConversationUnread>>;
  rooms: Readonly<Record<string, Room>>;
  roster: readonly Agent[];
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

/** Every place with something unread, for you first, then newest first. */
export const unreadRows = (s: RowSources): UnreadRow[] => {
  const rows: UnreadRow[] = [];
  for (const [key, u] of Object.entries(s.dms)) {
    if (!u.count) continue;
    const [hub = "", ...rest] = key.split("/");
    const agent = rest.join("/");
    const name = s.roster.find((a) => a.hubId === hub && a.id === agent)?.name ?? agent;
    const forYou = u.for_you > 0;
    rows.push({
      key: `dm:${key}`,
      place: { kind: "dm", hub, agent },
      urgency: forYou ? "forYou" : "new",
      count: forYou ? u.for_you : u.count,
      at: u.last?.at ?? null,
      title: name,
      line: `${plural(u.count, "new message")}${u.capped ? " or more" : ""}`,
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
      rows.push({
        key: `room:${room.id}`,
        place: { kind: "room", room: room.id },
        urgency: r.main.forYou ? "forYou" : "new",
        count: r.main.forYou || r.main.count,
        at: r.main.lastAt,
        title: room.name,
        line: first ? firstLine(first.content) : plural(r.main.count, "new message"),
        open: { kind: "room", roomId: room.id, threadId: null, ...(r.main.first ? { messageId: r.main.first } : {}) },
        read: { at: r.main.lastAt ?? new Date(0).toISOString(), message: null },
        unread: before(r.main.lastAt),
      });
    }
    for (const t of r.threads) {
      if (!t.unread.count) continue;
      rows.push({
        key: `thread:${room.id}/${t.parent.id}`,
        place: { kind: "thread", room: room.id, thread: t.parent.id },
        urgency: t.unread.forYou ? "forYou" : "new",
        count: t.unread.forYou || t.unread.count,
        at: t.unread.lastAt,
        title: `${room.name} ▸ thread`,
        line: firstLine(t.parent.content),
        open: { kind: "room", roomId: room.id, threadId: t.parent.id, ...(t.unread.first ? { messageId: t.unread.first } : {}) },
        read: { at: t.unread.lastAt ?? new Date(0).toISOString(), message: null },
        unread: before(t.unread.lastAt),
      });
    }
  }
  for (const u of s.local?.sessions ?? []) {
    const session = s.sessions[u.id];
    if (!session) continue;
    rows.push({
      key: `session:${u.id}`,
      place: { kind: "session", session: u.id },
      urgency: u.urgency === "new" ? "new" : "forYou",
      count: 1,
      at: u.since,
      title: s.sessionNames[u.id] ?? session.name,
      line: session.state === "done" ? "Finished" : session.state === "interrupted" ? "Interrupted" : session.state === "stopped" ? "Stopped" : "Closed",
      open: { kind: "session", sessionId: u.id },
      read: { at: u.since, message: null },
      unread: before(u.since),
    });
  }
  if (s.local?.brief && s.brief) {
    rows.push({
      key: "brief",
      place: { kind: "brief" },
      urgency: "forYou",
      count: 1,
      at: s.local.brief,
      title: "Desk report",
      line: firstLine(s.brief.text),
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
      line: "Restart to update; running sessions are resumed after.",
      open: null,
      read: { at: s.readyAt, message: s.ready },
      unread: null,
      version: s.ready,
    });
  }
  const t = (r: UnreadRow) => (r.at ? instant(r.at) : 0n);
  return rows.sort((a, b) => (a.urgency !== b.urgency ? (a.urgency === "forYou" ? -1 : 1) : t(a) > t(b) ? -1 : t(a) < t(b) ? 1 : 0));
};
