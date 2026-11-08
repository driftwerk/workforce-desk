// The DM on a hub with client ids (`desk.client_ids`): every message Desk
// sends carries an id of Desk's own, which the hub keeps it under, and every
// row the hub kept says where it is in the archive. A live message is known
// in what the hub kept by those ids alone, never by its words or its time.
// A hub without them is read by ./legacy.ts.
//
// One answer has no id of the hub's to be known by: one Desk heard only part
// of (it restarted mid-turn, so it never knew the question's client id), whose
// frames named no id, or whose turn's end said it wasn't kept under the id it
// streamed with. That one is known by what it says; and a live message the
// hub kept no copy of goes by its own time among what it kept, never below
// what was said after it.
import { LOCAL_ID } from "./history";
import type { ChatMessage } from "./types";

/** How much earlier than a live message the hub's copy of it may say it
 *  was (the hub's clock and this computer's need not agree). */
export const SKEW_MS = 2 * 60_000;

/** Whether live `m` is an answer the hub gave no id it is kept under. */
const unnamed = (m: ChatMessage): boolean =>
  m.role === "assistant" && m.status === "complete" && (!!m.byWords || m.id.startsWith(LOCAL_ID));

/** What a message says, whatever its spacing: the tools a live answer shows
 *  and the steps a kept one does are not its words. */
const wordsOf = (m: ChatMessage): string => m.content.replace(/\s+/g, " ").trim();

/** Whether kept `k` isn't from well before live `m` was. */
const notEarlier = (k: ChatMessage, m: ChatMessage): boolean => {
  const kt = Date.parse(k.at);
  const mt = Date.parse(m.at);
  return Number.isNaN(kt) || Number.isNaN(mt) || kt >= mt - SKEW_MS;
};

/** The live messages `kept` (a page the hub just read) now shows, to drop:
 *  one it kept under its id or its client id, and what a turn said live (its
 *  answer, its tools, its failure) once its turn is over and the hub kept
 *  the turn's own word on the message it was asked with. An answer with no
 *  id of the hub's is the oldest kept answer, not from well before it, that
 *  says the same and is no other live message's. */
export const keptOf = (kept: readonly ChatMessage[], live: readonly ChatMessage[]): Set<string> => {
  const ids = new Set(kept.map((m) => m.id));
  const clientIds = new Set(kept.flatMap((m) => (m.clientId ? [m.clientId] : [])));
  const answered = new Set(kept.flatMap((m) => (m.role !== "user" && m.replyTo ? [m.replyTo] : [])));
  const drop = new Set<string>();
  const byWords: ChatMessage[] = [];
  for (const m of live) {
    if (ids.has(m.id) || (m.clientId && clientIds.has(m.clientId))) drop.add(m.id);
    else if (m.role !== "user" && m.replyTo && m.status !== "streaming" && answered.has(m.replyTo)) drop.add(m.id);
    else if (unnamed(m) && wordsOf(m) !== "") byWords.push(m);
  }
  if (byWords.length === 0) return drop;
  // A kept row a live message is by its id is that one's, never another's.
  const taken = new Set(live.map((m) => m.id));
  const answers = inOrder(kept).filter((k) => k.role === "assistant" && !taken.has(k.id));
  for (const m of byWords) {
    const words = wordsOf(m);
    const k = answers.find((k) => !taken.has(k.id) && notEarlier(k, m) && wordsOf(k) === words);
    if (!k) continue;
    taken.add(k.id);
    drop.add(m.id);
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

/** `live` among `kept` (in the hub's order) by time: one that is over goes
 *  before the first kept message from well after it, since what was said
 *  after it was said after it; the rest, and one still streaming, follow
 *  what was kept, in the order they were said. */
const byTime = (kept: readonly ChatMessage[], live: readonly ChatMessage[]): ChatMessage[] => {
  const before = new Map<number, ChatMessage[]>();
  const after: ChatMessage[] = [];
  for (const m of live) {
    const t = Date.parse(m.at);
    const at = m.status === "streaming" || Number.isNaN(t) ? -1 : kept.findIndex((k) => Date.parse(k.at) > t + SKEW_MS);
    if (at < 0) after.push(m);
    else before.set(at, [...(before.get(at) ?? []), m]);
  }
  return [...kept.flatMap((k, i) => [...(before.get(i) ?? []), k]), ...after];
};

/** The conversation as shown: what the hub kept, in its order, with what is
 *  live and not yet kept by its time: after what was kept before it and
 *  before what was kept well after it, in the order it was said. Each
 *  message once, by its id, so no two are ever the same one; a live one the
 *  hub kept (by either id, or an answer with neither by its words) shows as
 *  kept. A turn's failure that a later answer replaced is marked superseded,
 *  to fold away, once a later turn of the conversation answers. */
export const shownWith = (kept: readonly ChatMessage[], live: readonly ChatMessage[]): ChatMessage[] => {
  const gone = keptOf(kept, live);
  const all = onceEach(byTime(inOrder(kept), live.filter((m) => !gone.has(m.id))));
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
