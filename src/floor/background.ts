import type { Background, Session, SessionState } from "../hub/types";
import { durationOf } from "./time";

/** "2 background tasks". */
export const backgroundTasks = (b: Background): string => `${b.count} background ${b.count === 1 ? "task" : "tasks"}`;

/** "Waiting on 2 background tasks · 6m". */
export const backgroundLine = (b: Background, now = Date.now()): string => `Waiting on ${backgroundTasks(b)} · ${durationOf(b.since, now)}`;

/** A session's state as Desk shows it: one whose turn ended while work it
 *  started still runs is working, not done. */
export const shownState = (s: Pick<Session, "state" | "background">): SessionState =>
  s.state === "done" && s.background ? "working" : s.state;
