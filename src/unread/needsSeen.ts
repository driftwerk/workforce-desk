import { create } from "zustand";
import type { FloorNeed } from "../floor/merge";
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
