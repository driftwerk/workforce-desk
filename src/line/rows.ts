import type { LineMessage, Session } from "../hub/types";
import { dayClock } from "../floor/time";

/** Who a message on `sessionId`'s line is from, as its thread names them. */
export const fromLabel = (m: LineMessage, sessionId: string): string => {
  switch (m.from.kind) {
    case "you":
      return "You";
    case "manager":
      return m.from.name || "Desk";
    case "desk":
      return m.from.name || "Desk";
    case "session":
      return m.from.id === sessionId ? "It" : m.from.name;
    case "agent":
      return m.from.name;
  }
};

/** Whom it is to, when that isn't the session itself. */
export const toLabel = (m: LineMessage, sessionId: string): string | null => {
  if (m.to.kind === "session" && m.to.id === sessionId) return null;
  switch (m.to.kind) {
    case "you":
      return "you";
    case "manager":
    case "desk":
      return m.to.name || "Desk";
    case "session":
    case "agent":
      return m.to.name;
  }
};

/** Whether the session sent it (rather than was sent it). */
export const outgoing = (m: LineMessage, sessionId: string): boolean => m.from.kind === "session" && m.from.id === sessionId;

const VERB: Record<LineMessage["kind"], string> = { ask: "asks", tell: "says", answer: "answers" };

/** The row's head: "It asks Desk", "Desk answers", "You say". */
export const headOf = (m: LineMessage, sessionId: string): string => {
  const from = fromLabel(m, sessionId);
  const to = toLabel(m, sessionId);
  const verb = from === "You" ? { ask: "ask", tell: "say", answer: "answer" }[m.kind] : VERB[m.kind];
  return to ? `${from} ${verb} ${to}` : `${from} ${verb}`;
};

/** Where a message to the session stands, in plain words; none once it is
 *  simply there (to the person or Desk) or delivered long ago. */
export const deliveryText = (m: LineMessage, now: number): string | null => {
  if (m.to.kind !== "session") return null;
  switch (m.delivery) {
    case "queued":
      switch (m.waiting) {
        case "typing":
          return "Waiting: you're typing in its terminal";
        case "stopped":
          return "Held: it gets this when it runs again";
        case "working":
          return "Waiting for it to finish its turn";
        case "paused":
          return "Waiting: Desk's breaker paused it";
        case "asking":
          return "Waiting: its turn ended asking you something";
        case "dialog":
          return "Waiting: a dialog in its terminal";
        case "person_driving":
          return "Waiting: you're driving";
        case "mode_ending":
          return "Waiting: Desk is putting it back in its own mode";
        case "next_call":
          return "Sent now: it reads this with its next tool call";
        case "awaited":
          return "Waiting: its call takes this as its answer";
        case "behind":
          return "Waiting behind one on its way in";
        default:
          return "Waiting to go in";
      }
    case "held":
      return "Held: it gets this when it runs again";
    case "handed":
      return "On its way";
    case "delivered":
      return m.deliveredAt ? `Delivered ${dayClock(m.deliveredAt, now)}` : "Delivered";
    case "refused":
      return "Not delivered: it has ended";
    case "withdrawn":
      // Its boss let it go, the person's own words came after it, or they
      // took it back: the hub doesn't say which.
      return "Not delivered: withdrawn before it went in";
    case "noted":
      return "A note here only: not typed in";
    case "unreceived":
      return "Not received: Desk tried twice and it never showed in the session";
    default:
      return unknown(m.delivery);
  }
};

/** A value a newer hub sends that this Desk doesn't know: no line, rather
 *  than a wrong one. Typed so a value added to the union is handled above. */
const unknown = (_: never): null => null;

/** Where a question stands. */
export const askedText = (m: LineMessage): string | null => {
  if (m.kind !== "ask") return null;
  switch (m.asked) {
    case "open":
      return m.to.kind === "you" ? "Waiting on you" : `Waiting on ${m.to.name || "Desk"}`;
    case "escalated":
      return "Desk gave this to you";
    case "answered":
      return "Answered";
    case "withdrawn":
      return "Withdrawn";
    case "lapsed":
      return "It went ahead without an answer";
    case "dismissed":
      return "Dismissed";
    default:
      return null;
  }
};

/** Whether the person is the one to answer it now. */
export const waitsOnYou = (m: LineMessage): boolean =>
  m.kind === "ask" && (m.asked === "escalated" || (m.asked === "open" && m.to.kind === "you"));

/** Whether the person can still change or take back their message. */
export const editable = (m: LineMessage): boolean => m.from.kind === "you" && (m.delivery === "queued" || m.delivery === "held");

/** Whether a session can be messaged at all, and what to say when not. */
export const lineOf = (s: Session): { on: true } | { on: false; why: string } => {
  if (s.origin === "external") return { on: false, why: "Not on Desk's line: it runs in another terminal." };
  if (!s.caps?.line || s.caps.line === "none") {
    const note = s.caps?.notes.find((n) => n.includes("message this session"));
    return { on: false, why: note ?? "This session's engine can't take messages from Desk." };
  }
  return { on: true };
};

/** Whether Send now goes into its running turn, and what the button says. */
export const steerOf = (s: Session): { label: string } | null => {
  // Waiting on a dialog (a permission, a question), nothing is typed in.
  if (s.state !== "working" || !s.caps?.steer || s.caps.steer === "none") return null;
  return { label: "Send now" };
};

/** `list` with `m` in its place: new ones at the end in time order, a
 *  changed one where it was, a removed one gone. */
export const merged = (list: readonly LineMessage[], m: LineMessage, removed = false): LineMessage[] => {
  if (removed) return list.filter((x) => x.id !== m.id);
  const at = list.findIndex((x) => x.id === m.id);
  if (at >= 0)
    return list.map((x, i) => {
      if (i !== at) return x;
      const same = m.delivery === x.delivery;
      return { ...m, waiting: m.waiting ?? (same ? x.waiting : undefined), actions: m.actions ?? (same ? x.actions : undefined) };
    });
  return [...list, m].sort((a, b) => a.at.localeCompare(b.at));
};

/** Whether `m` belongs on `sessionId`'s thread. */
export const onThread = (m: LineMessage, sessionId: string): boolean =>
  (m.from.kind === "session" && m.from.id === sessionId) || (m.to.kind === "session" && m.to.id === sessionId);

/** Why a boss's message waits that holds whoever drives: the hub's
 *  reasons it can't go in at all (stopped, the person typing, a dialog)
 *  and Desk's breaker come before the wheel. A running turn, "asking" and
 *  no reason at all rank below it: the hub says "you're driving" over a
 *  turn that runs. */
const BELOW_DRIVING: ReadonlySet<LineMessage["waiting"]> = new Set([undefined, "asking", "working"]);

/** Whether `m` answers the question its session's turn ended on, not an
 *  ask of its own (the hub's `answers_turn`). */
const answersTurn = (m: LineMessage): boolean => m.kind === "answer" && !m.inReplyTo;

/** `list` once the wheel of `sessionId`, which a boss runs, changed hands,
 *  as the hub's line gate reads it: the boss's tells, and its answers to
 *  the question a turn ended on, still waiting to go in wait on you while
 *  you drive, unless something the hub ranks first holds them; once you
 *  don't, "you're driving" is no longer why. Its questions, and its answers
 *  to a session's own asks, are never held for the wheel. */
export const withWheel = (list: readonly LineMessage[], sessionId: string, driving: boolean): LineMessage[] => {
  let changed = false;
  const next = list.map((m) => {
    const held = m.kind === "tell" || answersTurn(m);
    if (m.delivery !== "queued" || !held || m.from.kind !== "manager" || m.to.kind !== "session" || m.to.id !== sessionId) return m;
    const waiting = driving ? (BELOW_DRIVING.has(m.waiting) ? ("person_driving" as const) : m.waiting) : m.waiting === "person_driving" ? undefined : m.waiting;
    if (waiting === m.waiting) return m;
    changed = true;
    return { ...m, waiting };
  });
  return changed ? next : (list as LineMessage[]);
};
