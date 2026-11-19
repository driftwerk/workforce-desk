import type { Background, Session, SessionState } from "../hub/types";
import { clock, durationOf } from "./time";

/** "2 background tasks". */
export const backgroundTasks = (b: Background): string => `${b.count} background ${b.count === 1 ? "task" : "tasks"}`;

/** "Waiting on 2 background tasks · 6m". */
export const backgroundLine = (b: Background, now = Date.now()): string => `Waiting on ${backgroundTasks(b)} · ${durationOf(b.since, now)}`;

/** The background work a session shows as waiting on, if its turn ended
 *  while that work still runs. */
export const backgroundOf = (s: Pick<Session, "state" | "background">): Background | null =>
  s.state === "done" && s.background ? s.background : null;

/** "Restarted 18:32, re-checking its work": while a session restarted over
 *  work it had running is on its first turn since, that is what it does. */
export const restartedLine = (s: Pick<Session, "state" | "restarted">): string | null =>
  s.restarted && (s.state === "starting" || s.state === "working" || s.state === "blocked")
    ? `Restarted ${clock(s.restarted.at)}, re-checking its work`
    : null;

/** A session's status in words: "Restarted 18:32, re-checking its work"
 *  after a restart stopped its work, "Waiting on 2 background tasks · 6m"
 *  while its background work runs, else `labels`' word for its state. */
export const statusOf = (
  s: Pick<Session, "state" | "background" | "restarted">,
  labels: Readonly<Record<SessionState, string>>,
  now = Date.now(),
): string => {
  const restarted = restartedLine(s);
  if (restarted) return restarted;
  const background = backgroundOf(s);
  return background ? backgroundLine(background, now) : labels[s.state];
};

/** A session's state as Desk shows it: one whose turn ended while work it
 *  started still runs is working, not done. */
export const shownState = (s: Pick<Session, "state" | "background">): SessionState => (backgroundOf(s) ? "working" : s.state);

/** How a state is drawn: the dot, ring and tile classes (`dot-…`, `ring-…`,
 *  `tile-…`); background work is drawn as working's quieter kin. */
export type Look = SessionState | "background";

export const lookOf = (s: Pick<Session, "state" | "background">): Look =>
  backgroundOf(s) ? "background" : s.state === "asking" ? "blocked" : s.state;

/** Waiting on the person: on a request, or on what its turn ended asking. */
export const waitsOnYou = (s: Pick<Session, "state">): boolean => s.state === "blocked" || s.state === "asking";
