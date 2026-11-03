import type { LineMessage, Session } from "../hub/types";
import { dayClock } from "../floor/time";

/** Who a message on `sessionId`'s line is from, as its thread names them. */
export const fromLabel = (m: LineMessage, sessionId: string): string => {
  switch (m.from.kind) {
    case "you":
      return "You";
    case "manager":
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
  }
};

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
  const working = s.state === "working" || s.state === "blocked";
  if (!working || !s.caps?.steer || s.caps.steer === "none") return null;
  return { label: "Send now" };
};

/** `list` with `m` in its place: new ones at the end in time order, a
 *  changed one where it was, a removed one gone. */
export const merged = (list: readonly LineMessage[], m: LineMessage, removed = false): LineMessage[] => {
  if (removed) return list.filter((x) => x.id !== m.id);
  const at = list.findIndex((x) => x.id === m.id);
  if (at >= 0) return list.map((x, i) => (i === at ? { ...m, waiting: m.waiting ?? (m.delivery === x.delivery ? x.waiting : undefined) } : x));
  return [...list, m].sort((a, b) => a.at.localeCompare(b.at));
};

/** Whether `m` belongs on `sessionId`'s thread. */
export const onThread = (m: LineMessage, sessionId: string): boolean =>
  (m.from.kind === "session" && m.from.id === sessionId) || (m.to.kind === "session" && m.to.id === sessionId);
