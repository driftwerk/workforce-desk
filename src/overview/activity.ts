import type { ActivityEvent, ActivityFilter, ActivityKind, ActivityParty, Need } from "../hub/types";

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
 *  branch to deploy". Sessions you've named in Desk (`names`, by session
 *  id) go by that name; the hub's text is still split at the name it used. */
export const lineOf = (e: ActivityEvent, names: Readonly<Record<string, string>> = {}): Line => {
  const shown = (p: ActivityParty) => (p.kind === "session" ? (names[p.id] ?? p.name) : p.name);
  const acting = e.actor.kind === "manager" || e.actor.kind === "you" || !e.subject;
  const who = acting ? e.actor : e.subject!;
  const lead = who.kind === "you" ? { name: "You", session: false } : { name: shown(who), session: who.kind === "session" };
  const other = acting && e.subject && e.subject.id !== who.id ? e.subject : null;
  const text = e.text.trim();
  if (!other) return { lead, parts: [{ text }] };
  const at = other.name ? text.indexOf(other.name) : -1;
  const isSession = other.kind === "session";
  if (at < 0) return { lead, parts: [{ text }, { text: " · " }, { text: shown(other), session: isSession, name: true }] };
  return {
    lead,
    parts: [
      { text: text.slice(0, at) },
      { text: shown(other), session: isSession, name: true },
      { text: text.slice(at + other.name.length) },
    ].filter((p) => p.text !== ""),
  };
};

/** What became of an event that needed the person. */
export type NeedState = { open: true } | { open: false; at: string | null; how: string };

/** Whether an open need is what an event asked: the approval it waits on,
 *  or a question from the same agent or session. */
const isNeedOf = (e: ActivityEvent, n: Pick<Need, "id" | "kind" | "who">): boolean =>
  !!e.subject &&
  n.who.id === e.subject.id &&
  (e.kind === "needs_you" ? !!e.approvalId && n.id.startsWith("wait:") && n.id.endsWith(`:${e.approvalId}`) : n.id.startsWith("question:"));

const RESOLVED_BY = new Set<ActivityKind>(["approved", "denied", "answered"]);

const howResolved = (e: ActivityEvent): string => {
  const by = e.actor.kind === "you" ? "you" : e.actor.name;
  return e.kind === "approved" ? `allowed by ${by}` : e.kind === "denied" ? `denied by ${by}` : "answered in its terminal";
};

/** For every event in `events` that needed the person: still open (one of
 *  `needs`, this hub's open needs), or resolved — by the later event that
 *  answered its approval (when, and how), else no longer waiting. Only a
 *  subject's latest question can be its open one. */
export const needStates = (events: readonly ActivityEvent[], needs: readonly Pick<Need, "id" | "kind" | "who">[]): Map<string, NeedState> => {
  const latestQuestion = new Map<string, ActivityEvent>();
  for (const e of events)
    if (e.kind === "question" && e.subject && (latestQuestion.get(e.subject.id)?.at ?? "") < e.at) latestQuestion.set(e.subject.id, e);
  return new Map(
    events
      .filter((e) => NEEDS_YOU.has(e.kind))
      .map((e): [string, NeedState] => {
        const current = e.kind === "needs_you" || (e.subject && latestQuestion.get(e.subject.id)?.id === e.id);
        if (current && needs.some((n) => isNeedOf(e, n))) return [e.id, { open: true }];
        const answer = e.approvalId ? events.find((a) => a.approvalId === e.approvalId && RESOLVED_BY.has(a.kind) && a.at >= e.at && a.id !== e.id) : undefined;
        return [e.id, answer ? { open: false, at: answer.at, how: howResolved(answer) } : { open: false, at: null, how: "no longer waiting" }];
      }),
  );
};
