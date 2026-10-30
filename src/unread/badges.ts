import type { FloorNeed } from "../floor/merge";
import { itemKeyOf } from "../floor/needs";
import { sessionOf, type ItemKey } from "../groups/model";
import type { RoomDraft } from "../hub/store";
import type { Count, RoomSummary, SessionUnread, UnreadSummary } from "../hub/types";
import type { ConversationUnread } from "../hubs/surface";

// Every badge Desk shows, from one set of rules: a number counts what needs
// you and what's for you, a dot means only something new. Each item is
// counted once: a Floor need by the item it belongs to (a room's by its
// room, never by its agent's DM), and once in the total.

export interface Badge {
  count: number;
  /** Unread, none of it for you. */
  dot: boolean;
}

/** A room's: its badge, and whether a member is answering, or queued to. */
export interface RoomMarker extends Badge {
  working: boolean;
}

export const NO_BADGE: Badge = { count: 0, dot: false };

const badge = (count: number, anyNew: boolean): Badge => ({ count, dot: count === 0 && anyNew });

/** "99+" past 99. */
export const countLabel = (n: number): string => (n > 99 ? "99+" : String(n));

const newIn = (u: { count: number; forYou: number } | undefined) => (u ? u.count - u.forYou : 0);

/** The needs placed in a room, by room id. */
export const inRoom = (needs: readonly FloorNeed[], room: string): FloorNeed[] =>
  needs.filter((n) => n.place.kind === "room" && n.place.room === room);

/** The needs a sidebar item carries itself: an agent's, but for those placed
 *  in a room, which the room carries. */
export const ofItem = (needs: readonly FloorNeed[], item: string): FloorNeed[] =>
  needs.filter((n) => n.place.kind !== "room" && itemKeyOf(n) === item);

export const badgeOfDm = (u: ConversationUnread | undefined, needs: readonly FloorNeed[]): Badge =>
  badge((u?.for_you ?? 0) + needs.length, !!u && u.count > u.for_you);

/** A blocked session is a need; one done since it was seen is a number,
 *  one stopped or closed with a reply a dot. */
export const badgeOfSession = (u: SessionUnread | undefined, needs: readonly FloorNeed[]): Badge =>
  badge(needs.length + (u && u.urgency !== "new" ? 1 : 0), u?.urgency === "new");

const settledBadly = (d: RoomDraft) => d.state === "failed" || d.state === "stopped";
const busy = (d: RoomDraft) => d.state !== "failed" && d.state !== "stopped" && d.state !== "interrupted";

/** A room's: what's for you in its timeline and threads, the needs placed
 *  in it, failed and stopped answers, and on a hub without a Floor (whose
 *  needs nobody lists) what its drafts ask. */
export const badgeOfRoom = (
  s: RoomSummary | undefined,
  drafts: readonly RoomDraft[],
  needs: readonly FloorNeed[],
  hasFloor: (hub: string) => boolean = () => true,
): RoomMarker => {
  const threads = s?.threads ?? [];
  const forYou = (s?.main.forYou ?? 0) + threads.reduce((n, t) => n + t.unread.forYou, 0);
  const prompts = drafts.reduce((n, d) => n + (hasFloor(d.member.split("/")[0] ?? "") ? 0 : d.prompts.length), 0);
  const count = forYou + needs.length + drafts.filter(settledBadly).length + prompts;
  const anyNew = newIn(s?.main) + threads.reduce((n, t) => n + newIn(t.unread), 0) > 0;
  return { ...badge(count, anyNew), working: drafts.some(busy) };
};

/** A group's, or a grid's: its items' together. */
export const badgeOfGroup = (items: readonly Badge[]): Badge =>
  badge(
    items.reduce((n, b) => n + b.count, 0),
    items.some((b) => b.dot),
  );
export const badgeOfGrid = badgeOfGroup;

/** The Floor's: needs as a number, an unread brief as one more, new
 *  Activity as a dot. */
export const badgeOfFloor = (needs: readonly FloorNeed[], activity: Count | undefined, brief: string | null | undefined): Badge =>
  badge(needs.length + (brief ? 1 : 0), (activity?.count ?? 0) > 0);

/** Everything, each item once: every need on every hub, then what's for you
 *  in DMs, rooms and threads, sessions, the brief, failed and stopped
 *  drafts; a dot for anything only new. */
export const totalOf = (all: {
  needs: readonly FloorNeed[];
  dms: Readonly<Record<string, ConversationUnread>>;
  local: UnreadSummary | null;
  drafts: Readonly<Record<string, readonly RoomDraft[]>>;
  update: boolean;
}): Badge => {
  const dms = Object.values(all.dms);
  const rooms = all.local?.rooms ?? [];
  const sessions = all.local?.sessions ?? [];
  const drafts = Object.values(all.drafts).flat();
  const roomsFor = rooms.reduce((n, r) => n + r.main.forYou + r.threads.reduce((m, t) => m + t.unread.forYou, 0), 0);
  const count =
    all.needs.length +
    dms.reduce((n, u) => n + u.for_you, 0) +
    roomsFor +
    sessions.filter((u) => u.urgency !== "new").length +
    (all.local?.brief ? 1 : 0) +
    drafts.filter(settledBadly).length;
  const anyNew =
    dms.some((u) => u.count > u.for_you) ||
    rooms.some((r) => newIn(r.main) > 0 || r.threads.some((t) => newIn(t.unread) > 0)) ||
    sessions.some((u) => u.urgency === "new") ||
    (all.local?.activity.count ?? 0) > 0 ||
    all.update;
  return badge(count, anyNew);
};

/** What a sidebar item's badge is read from. */
export interface BadgeData {
  needs: readonly FloorNeed[];
  dms: Readonly<Record<string, ConversationUnread>>;
  sessions: readonly SessionUnread[];
}

/** A sidebar item's badge: an agent's DM, or a session. */
export const itemBadge = (key: ItemKey, d: BadgeData): Badge => {
  const session = sessionOf(key);
  if (session) return badgeOfSession(d.sessions.find((u) => u.id === session), ofItem(d.needs, key));
  if (key.startsWith("agent:")) return badgeOfDm(d.dms[key.slice("agent:".length)], ofItem(d.needs, key));
  return NO_BADGE;
};
