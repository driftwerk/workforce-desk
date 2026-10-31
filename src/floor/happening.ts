import type { Background, Place, Who } from "../hub/types";
import { backgroundTasks } from "./background";
import type { FloorWork, Merged, Tagged } from "./merge";
import { ownName } from "./needs";
import { since } from "./time";

/** How long an agent or session that finished stays in what's happening. */
export const DONE_FOR_MS = 2 * 60 * 60_000;

export type EntryState = "working" | "waiting" | "done" | "failed";

/** One agent or session working, waiting on its own background work, or
 *  finished lately: what it is for and what it is doing, in plain words. */
export interface FloorEntry extends Tagged {
  who: Who;
  place: Place;
  state: EntryState;
  background: Background | null;
  purpose: string | null;
  now: string;
  /** When what it says was last written. */
  at: string;
}

const RANK: Record<EntryState, number> = { working: 0, waiting: 1, done: 2, failed: 2 };

const stateOf = (w: FloorWork): EntryState =>
  w.endedAt === null ? (w.background ? "waiting" : "working") : w.outcome === "failed" || w.outcome === "limit" ? "failed" : "done";

/** "12 min ago", "just now". */
const ago = (iso: string | null, now: number): string => {
  const t = since(iso, now);
  return t === "just now" || !t ? t : `${t} ago`;
};

/** What Desk says of a turn its hub sent no gist for, from what it knows
 *  and never from what the turn was asked: "Working on acme-web.", "Waiting
 *  on 2 background tasks.", "Finished 12 min ago." `subject` names what a
 *  session is about. */
const plainly = (w: FloorWork, state: EntryState, subject: string | null, now: number): string => {
  const when = ago(w.endedAt, now);
  const at = (said: string) => `${said}${when ? ` ${when}` : ""}.`;
  switch (state) {
    case "working":
      return subject ? `Working on ${subject}.` : "Working on it now.";
    case "waiting":
      return `Waiting on ${backgroundTasks(w.background!)}.`;
    case "done":
      return at("Finished");
    case "failed":
      return at(w.outcome === "limit" ? "Stopped at its plan’s limit" : "Stopped with an error");
  }
};

const keyOf = (w: FloorWork, who: Who): string => `${w.hubId}/${who.kind}:${who.id}`;

const entryOf = (w: FloorWork, who: Who, subject: string | null, now: number): FloorEntry => {
  const state = stateOf(w);
  return {
    hubId: w.hubId,
    local: w.local,
    stale: w.stale,
    key: keyOf(w, who),
    who,
    place: w.place,
    state,
    background: w.background ?? null,
    purpose: w.gist?.purpose ?? null,
    now: w.gist?.now ?? plainly(w, state, subject, now),
    at: w.gist?.at ?? w.endedAt ?? w.heardAt,
  };
};

/** What's happening on every hub: one entry per agent or session working,
 *  waiting on its background work, or finished within the last two hours;
 *  working first, then waiting, then finished, each most recently written
 *  first. Of a subject's turns, the one furthest along that order, and of
 *  those one its hub said a gist of, then the latest, speaks for it. `whoOf` says who a turn is, so a
 *  session an agent's turn ran as is that agent's entry, and one that is no
 *  one's (null) has none; `subjectOf`, what a session is about, for a turn
 *  with no gist. */
export const happening = (
  m: Pick<Merged, "working" | "done">,
  now: number,
  whoOf: (w: FloorWork) => Who | null = (w) => w.who,
  subjectOf: (item: { local: boolean; who: Who }) => string | null = ({ who }) => (who.kind === "session" ? ownName(who) : null),
): FloorEntry[] => {
  const lately = m.done.filter((w) => w.endedAt !== null && now - Date.parse(w.endedAt) <= DONE_FOR_MS);
  const when = (w: FloorWork): string => w.endedAt ?? w.since;
  const chosen = new Map<string, { w: FloorWork; who: Who }>();
  for (const w of [...m.working, ...lately]) {
    const who = whoOf(w);
    if (!who) continue;
    const key = keyOf(w, who);
    const have = chosen.get(key)?.w;
    const said = (x: FloorWork): number => Number(!!x.gist);
    const better =
      !have ||
      RANK[stateOf(w)] < RANK[stateOf(have)] ||
      (RANK[stateOf(w)] === RANK[stateOf(have)] && (said(w) > said(have) || (said(w) === said(have) && when(w) > when(have))));
    if (better) chosen.set(key, { w, who });
  }
  return [...chosen.values()]
    .map(({ w, who }) => entryOf(w, who, subjectOf({ local: w.local, who }), now))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.at.localeCompare(a.at) || a.who.name.localeCompare(b.who.name));
};
