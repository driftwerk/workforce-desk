// The DM on a hub with client ids (`desk.client_ids`): every message Desk
// sends carries an id of Desk's own, which the hub keeps it under, and every
// row the hub kept says where it is in the archive. A live message is known
// in what the hub kept by those ids alone, never by its words or its time.
// A hub without them is read by ./legacy.ts.
import type { ChatMessage } from "./types";

/** The live messages `kept` (a page the hub just read) now shows, to drop:
 *  one it kept under its id or its client id, and what a turn said live (its
 *  answer, its tools, its failure) once its turn is over and the hub kept
 *  the turn's own word on the message it was asked with. */
export const keptOf = (kept: readonly ChatMessage[], live: readonly ChatMessage[]): Set<string> => {
  const ids = new Set(kept.map((m) => m.id));
  const clientIds = new Set(kept.flatMap((m) => (m.clientId ? [m.clientId] : [])));
  const answered = new Set(kept.flatMap((m) => (m.role !== "user" && m.replyTo ? [m.replyTo] : [])));
  const drop = new Set<string>();
  for (const m of live) {
    if (ids.has(m.id) || (m.clientId && clientIds.has(m.clientId))) drop.add(m.id);
    else if (m.role !== "user" && m.replyTo && m.status !== "streaming" && answered.has(m.replyTo)) drop.add(m.id);
  }
  return drop;
};

/** `messages`, each id once (the first): a list React keys by id never
 *  holds two of one, whatever a hub sent. */
export const onceEach = (messages: readonly ChatMessage[]): ChatMessage[] => {
  const seen = new Set<string>();
  return messages.filter((m) => !seen.has(m.id) && !!seen.add(m.id));
};

/** `kept` in the hub's archive order, by its numbering. A file that is a
 *  message of its own has none: it takes the number of the row the hub put
 *  it after (its message), or before when it leads, and keeps its place
 *  beside it. */
const inOrder = (kept: readonly ChatMessage[]): ChatMessage[] => {
  const numbered = kept.map((m, i) => {
    if (m.seq !== undefined) return { m, seq: m.seq, i };
    const before = kept.slice(0, i).reverse().find((k) => k.seq !== undefined);
    const after = kept.slice(i + 1).find((k) => k.seq !== undefined);
    return { m, seq: before?.seq ?? after?.seq ?? 0, i };
  });
  return numbered.sort((a, b) => a.seq - b.seq || a.i - b.i).map(({ m }) => m);
};

/** Whether `m` is an answer to a turn of the conversation: what a reminder,
 *  a job or another delivery says doesn't answer what failed. */
const answers = (m: ChatMessage): boolean =>
  m.role === "assistant" && m.status === "complete" && !!m.content.trim() && !!m.replyTo && !m.delivery;

/** The conversation as shown: what the hub kept, in its order, then what is
 *  live and not yet kept, in the order it was said. Each message once, by its
 *  id, so no two are ever the same one; a live one the hub kept (by either
 *  id) shows as kept. A turn's failure that a later answer replaced is
 *  marked superseded, to fold away, once a later turn of the conversation
 *  answers; it is never moved. */
export const shownWith = (kept: readonly ChatMessage[], live: readonly ChatMessage[]): ChatMessage[] => {
  const gone = keptOf(kept, live);
  const all = onceEach([...inOrder(kept), ...live.filter((m) => !gone.has(m.id))]);
  let answeredLater = false;
  const out: ChatMessage[] = new Array(all.length);
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]!;
    if (m.status === "error") out[i] = answeredLater && !m.superseded ? { ...m, superseded: true } : m;
    else {
      if (answers(m)) answeredLater = true;
      out[i] = m;
    }
  }
  return out;
};
