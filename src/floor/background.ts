import type { Background, Session, SessionState } from "../hub/types";
import { clock, durationOf } from "./time";

/** "2 background tasks". */
export const backgroundTasks = (b: Background): string => `${b.count} background ${b.count === 1 ? "task" : "tasks"}`;

/** "Waiting on 2 background tasks · 6m". */
export const backgroundLine = (b: Background, now = Date.now()): string => `Waiting on ${backgroundTasks(b)} · ${durationOf(b.since, now)}`;

/** What a working session is held up on: "waiting for a build slot, 3m". */
export const waitsLine = (w: NonNullable<Session["waits"]>, now = Date.now()): string => `${w.words}, ${durationOf(w.since, now)}`;

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
 *  while its background work runs, "Desk has it" while its boss deals with
 *  what it waits on, else `labels`' word for its state. */
export const statusOf = (
  s: Pick<Session, "state" | "background"> & { restarted?: Session["restarted"]; bossHas?: string | null },
  labels: Readonly<Record<SessionState, string>>,
  now = Date.now(),
): string => {
  const restarted = restartedLine({ state: s.state, restarted: s.restarted ?? null });
  if (restarted) return restarted;
  const background = backgroundOf(s);
  return background ? backgroundLine(background, now) : bossHandles(s) ? handledText(s) : labels[s.state];
};

/** A session's state as Desk shows it: one whose turn ended while work it
 *  started still runs is working, not done. */
export const shownState = (s: Pick<Session, "state" | "background">): SessionState => (backgroundOf(s) ? "working" : s.state);

/** How a state is drawn: the dot, ring and tile classes (`dot-…`, `ring-…`,
 *  `tile-…`); background work is drawn as working's quieter kin, and what
 *  its boss deals with calmly ("handled"), never as needing the person. */
export type Look = SessionState | "background" | "handled";

/** Stopped on a request, or on what its turn ended asking. */
const stopped = (s: Pick<Session, "state">): boolean => s.state === "blocked" || s.state === "asking";

/** Stopped on what its boss has (`bossHas`): the boss deals with it, so it
 *  calls for nobody's attention. */
export const bossHandles = (s: Pick<Session, "state"> & { bossHas?: string | null }): boolean => stopped(s) && !!s.bossHas;

export const lookOf = (s: Pick<Session, "state" | "background"> & { bossHas?: string | null }): Look =>
  backgroundOf(s) ? "background" : bossHandles(s) ? "handled" : s.state === "asking" ? "blocked" : s.state;

/** Waiting on the person: on a request, or on what its turn ended asking,
 *  and no boss has it (one that does deals with it first). */
export const waitsOnYou = (s: Pick<Session, "state"> & { bossHas?: string | null }): boolean => stopped(s) && !s.bossHas;

/** What its boss holds a session for, as the person's to answer, while it
 *  is stopped on nothing it asked itself: "Desk asks you: Ship the small
 *  scope or the whole ticket?" (DW-755). */
export const heldFor = (s: Pick<Session, "state"> & { bossHas?: string | null; waitsOnYou?: string | null }): string | null =>
  !stopped(s) && !s.bossHas && s.waitsOnYou ? s.waitsOnYou : null;

/** What a session its boss deals with says: "Desk has it". */
export const handledText = (s: { bossHas?: string | null }): string => `${s.bossHas || "Your boss"} has it`;
