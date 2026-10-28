import type { ActivityEvent, ActivityFilter, ActivityKind } from "../hub/types";

/** Kinds the "Needs you" filter shows. */
const NEEDS_YOU = new Set<ActivityKind>(["needs_you", "question"]);

/** Whether a live event belongs in a filter's list. (Pages come filtered by
 *  the hub; this places what arrives on the socket.) */
export const matches = (filter: ActivityFilter, e: ActivityEvent): boolean =>
  filter === "all" || (filter === "needs_you" ? NEEDS_YOU.has(e.kind) : e.actor.kind === "manager");

const newestFirst = (a: ActivityEvent, b: ActivityEvent): number => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

/** Both lists as one, newest first, each event once (the later copy wins). */
export const mergeEvents = (a: readonly ActivityEvent[], b: readonly ActivityEvent[]): ActivityEvent[] => {
  const byId = new Map(a.map((e) => [e.id, e]));
  for (const e of b) byId.set(e.id, e);
  return [...byId.values()].sort(newestFirst);
};

export type Tone = "manager" | "blocked" | "done" | "working" | "failed" | "quiet" | "you";

/** The colour of an event's dot. */
export const toneOf = (e: ActivityEvent): Tone => {
  if (e.actor.kind === "manager") return "manager";
  if (e.actor.kind === "you") return "you";
  switch (e.kind) {
    case "needs_you":
    case "question":
      return "blocked";
    case "finished":
    case "answered":
    case "approved":
      return "done";
    case "failed":
    case "limit":
    case "denied":
      return "failed";
    case "quiet":
    case "stopped":
      return "quiet";
    default:
      return "working";
  }
};

export interface Line {
  /** Who the sentence is about: the overseer or you for your actions, else
   *  the agent or session. */
  lead: { name: string; session: boolean } | null;
  /** The rest, with the subject's name marked where it appears. */
  parts: { text: string; session?: boolean; name?: boolean }[];
}

/** An event as a sentence: "Desk asked workforce-e7 …", "Scout asked which
 *  branch to deploy". */
export const lineOf = (e: ActivityEvent): Line => {
  const acting = e.actor.kind === "manager" || e.actor.kind === "you" || !e.subject;
  const who = acting ? e.actor : e.subject!;
  const lead = who.kind === "you" ? { name: "You", session: false } : { name: who.name, session: who.kind === "session" };
  const other = acting && e.subject && e.subject.id !== who.id ? e.subject : null;
  const text = e.text.trim();
  if (!other) return { lead, parts: [{ text }] };
  const at = other.name ? text.indexOf(other.name) : -1;
  const isSession = other.kind === "session";
  if (at < 0) return { lead, parts: [{ text }, { text: " · " }, { text: other.name, session: isSession, name: true }] };
  return {
    lead,
    parts: [
      { text: text.slice(0, at) },
      { text: other.name, session: isSession, name: true },
      { text: text.slice(at + other.name.length) },
    ].filter((p) => p.text !== ""),
  };
};
