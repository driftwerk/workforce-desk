import { create } from "zustand";
import type { FloorNeed } from "../floor/merge";
import type { RoomMessage } from "../hub/types";
import { deskState } from "../restore/boot";
import { instant } from "../rooms/time";
import { useWatching, watched } from "./watching";

// An agent's question asked in its DM is a reply like any other there: with
// the DM on screen in a focused Desk window it needs nothing more of you,
// and once you've opened the DM it's seen, so it waits on no badge, no
// Floor row and no Unread row. One asked while you were elsewhere counts as
// usual until you open the DM. (Its hub settles it once you answer.) An
// approval asked there still needs you. Seen needs are kept with Desk's
// state (see `watchNeedsSeen`), so every window, and the next start, agree;
// one its hub no longer lists is let go.

/** Where seen needs are kept with Desk's state. */
export const NEEDS_SEEN_KEY = "unread.needs.seen";

/** The needs seen in their DMs, by need key (`hub/need`). */
export const useNeedsSeen = create<{ seen: ReadonlySet<string> }>(() => ({ seen: new Set() }));

/** The DM a need was asked in, by place key, for an agent's question there. */
export const dmOfNeed = (n: Pick<FloorNeed, "kind" | "place" | "who" | "hubId">): string | null =>
  n.kind === "question" && n.place.kind === "dm" && n.who.kind === "agent" ? `dm:${n.hubId}/${n.who.id}` : null;

/** Whether `n` waits on you: not asked in a DM that's on screen here or
 *  was opened since it was asked. */
export const stillNeeds = (n: FloorNeed, seen: ReadonlySet<string>, here: (key: string) => boolean): boolean => {
  const dm = dmOfNeed(n);
  return !dm || !(seen.has(n.key) || here(dm));
};

/** Seen needs as kept: only the keys. */
export const seenFrom = (v: unknown): ReadonlySet<string> =>
  new Set(Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []);

/** Needs `listed` asked in a DM on screen now are seen; seen ones no longer
 *  listed by a hub that answered (`answered`) are let go. Says whether
 *  anything changed. */
export function noteSeen(listed: readonly FloorNeed[], answered: (hubId: string) => boolean): boolean {
  const was = useNeedsSeen.getState().seen;
  const w = useWatching.getState();
  const next = new Set(was);
  for (const n of listed) {
    const dm = dmOfNeed(n);
    if (dm && watched(w, dm)) next.add(n.key);
  }
  const keys = new Set(listed.map((n) => n.key));
  for (const k of was) if (!keys.has(k) && answered(k.slice(0, k.indexOf("/")))) next.delete(k);
  const changed = next.size !== was.size || [...next].some((k) => !was.has(k));
  if (changed) useNeedsSeen.setState({ seen: next });
  return changed;
}

// A question an agent asked in a room is answered by whatever you post in
// that room (or thread) after it, to anyone; and any need can be set aside
// as not needed. Dismissed needs are kept with Desk's state, like seen ones.

/** Where dismissed needs are kept with Desk's state. */
export const NEEDS_DISMISSED_KEY = "unread.needs.dismissed";

/** The needs set aside as not needed, by need key. */
export const useNeedsDismissed = create<{ gone: ReadonlySet<string> }>(() => ({ gone: new Set() }));

/** Sets `key` aside: it waits on no badge, Floor row or Unread row. */
export function dismissNeed(key: string): void {
  const gone = new Set(useNeedsDismissed.getState().gone).add(key);
  useNeedsDismissed.setState({ gone });
  deskState.set(NEEDS_DISMISSED_KEY, [...gone]);
}

/** Dismissed needs a hub that answered no longer lists are let go. Says
 *  whether anything changed. */
export function noteDismissed(listed: readonly FloorNeed[], answered: (hubId: string) => boolean): boolean {
  const was = useNeedsDismissed.getState().gone;
  const keys = new Set(listed.map((n) => n.key));
  const next = new Set([...was].filter((k) => keys.has(k) || !answered(k.slice(0, k.indexOf("/")))));
  if (next.size === was.size) return false;
  useNeedsDismissed.setState({ gone: next });
  return true;
}

/** When you last posted in each room (by room id) and thread (`room/thread`). */
export type YourPosts = Readonly<Record<string, string>>;

let postsOf: { from: unknown; posts: YourPosts } | null = null;
/** `timelines`' newest post of yours per room and thread, worked out once
 *  per change of the timelines. */
export const yourPosts = (timelines: Readonly<Record<string, readonly RoomMessage[]>>): YourPosts => {
  if (postsOf?.from === timelines) return postsOf.posts;
  const posts: Record<string, string> = {};
  const note = (key: string, at: string) => {
    if (!posts[key] || instant(at) > instant(posts[key]!)) posts[key] = at;
  };
  for (const [room, messages] of Object.entries(timelines))
    for (const m of messages) {
      if (m.author !== "you") continue;
      note(room, m.createdAt);
      if (m.threadId) note(`${room}/${m.threadId}`, m.createdAt);
    }
  postsOf = { from: timelines, posts };
  return posts;
};

/** Whether `n`, an agent's question in a room or thread, has been answered
 *  by a post of yours there since it was asked. A DM's needs a message in
 *  that DM, which the hub settles. */
export const answeredInRoom = (n: Pick<FloorNeed, "kind" | "place" | "who" | "since">, posts: YourPosts): boolean => {
  if (n.kind !== "question" || n.who.kind !== "agent" || n.place.kind !== "room") return false;
  const last = posts[n.place.thread ? `${n.place.room}/${n.place.thread}` : n.place.room];
  return !!last && instant(last) > instant(n.since);
};
