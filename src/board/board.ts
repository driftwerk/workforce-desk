// The board's decisions, as pure functions over tickets: its five columns,
// what each filter and search shows, what's settled or snoozed now, what a
// ticket waits on, and where a dropped card lands. The hub computes `ready`,
// `blockers`, `settled` and `snoozed` as it sends a ticket; these say the
// same of the tickets as they stand now (a need done since, three days gone
// by) without asking it again.

import type { ActivityEvent, LedgerRow, Ticket, TicketMove, TicketState } from "../hub/types";
import { totalTokens } from "../spend/spend";

/** The columns, left to right; Dropped has none and folds under Done. */
export const COLUMNS: readonly { state: Exclude<TicketState, "dropped">; title: string }[] = [
  { state: "backlog", title: "Backlog" },
  { state: "todo", title: "To do" },
  { state: "doing", title: "Doing" },
  { state: "review", title: "Review" },
  { state: "done", title: "Done" },
];

export const STATE_TITLE: Record<TicketState, string> = {
  backlog: "Backlog",
  todo: "To do",
  doing: "Doing",
  review: "Review",
  done: "Done",
  dropped: "Dropped",
};

/** How long a Done ticket stays out before it settles. */
export const SETTLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** The rank step between cards, as the hub spaces them. */
export const RANK_STEP = 1024;

export type BoardFilter = "all" | "mine" | "unassigned" | "waiting" | "pinned";

/** Whether a ticket is the person's: its issue is theirs there (by the id
 *  the board's link knows them by), or it is handed to them here. */
export const isMine = (t: Pick<Ticket, "assignee" | "external">, me: string | null | undefined): boolean =>
  t.assignee?.kind === "you" || (!!me && !!t.external?.assignee && t.external.assignee.id === me);

/** Whether no one has a ticket: no one there (on a synced board) and no
 *  one here. */
export const isUnassigned = (t: Pick<Ticket, "assignee" | "external">): boolean => !t.assignee && (t.external ? t.external.assignee === null : true);

/** The board's quick filters: whose tickets (everyone's, yours, no one's),
 *  then what waits on you and what's pinned. */
export const FILTERS: readonly { id: BoardFilter; label: string }[] = [
  { id: "all", label: "Everyone" },
  { id: "mine", label: "Mine" },
  { id: "unassigned", label: "Unassigned" },
  { id: "waiting", label: "Waiting on me" },
  { id: "pinned", label: "Pinned" },
];

/** Whether `t` is what quick filter `f` shows; `me` is who the person is on
 *  the board's Jira or Linear, when known. */
export const shownBy = (t: Ticket, f: BoardFilter, waiting: (t: Ticket) => boolean, me?: string | null): boolean => {
  switch (f) {
    case "all":
      return true;
    case "mine":
      return isMine(t, me);
    case "unassigned":
      return isUnassigned(t);
    case "pinned":
      return t.pinned;
    case "waiting":
      return waitingOnYou(t, waiting);
  }
};

const at = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Done for three days, or Dropped: on the settled shelf. */
export const settled = (t: Pick<Ticket, "state" | "stateAt">, now: number): boolean =>
  t.state === "dropped" || (t.state === "done" && now - at(t.stateAt) >= SETTLE_AFTER_MS);

/** Hidden while snoozed: as the hub said, until its time comes. */
export const snoozed = (t: Pick<Ticket, "snoozed" | "snoozedUntil">, now: number): boolean =>
  t.snoozed && !!t.snoozedUntil && at(t.snoozedUntil) > now;

/** Its needs not yet done, by the tickets' states now. */
export const blockers = (t: Pick<Ticket, "needs">, states: ReadonlyMap<string, TicketState>): string[] =>
  t.needs.filter((n) => states.get(n) !== "done");

/** To do with every need done: what may be handed out. */
export const ready = (t: Pick<Ticket, "state" | "needs">, states: ReadonlyMap<string, TicketState>): boolean =>
  t.state === "todo" && blockers(t, states).length === 0;

/** A rank between two neighbours; null when there's no room left between
 *  them (the hub then spaces the column out). */
export const rankBetween = (before: number | null, after: number | null): number | null => {
  if (before === null && after === null) return RANK_STEP;
  if (after === null) return before! + RANK_STEP;
  if (before === null) return after - RANK_STEP;
  const mid = before + (after - before) / 2;
  return before < mid && mid < after ? mid : null;
};

/** A ticket's key as typed: `ACM-12`, `acm-12`. */
const KEY = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d+)$/;

/** `ACM-12` from a search, upper-cased; null when it isn't a key. */
export const keyOf = (q: string): string | null => {
  const m = KEY.exec(q.trim());
  return m && Number(m[2]) > 0 ? `${m[1]!.toUpperCase()}-${Number(m[2])}` : null;
};

/** Whether `t` is what `q` asks for: its key when `q` is one (exactly), else
 *  every word somewhere in its key, title or description. */
export const matches = (t: Pick<Ticket, "key" | "title" | "body">, q: string): boolean => {
  const query = q.trim();
  if (!query) return true;
  const key = keyOf(query);
  if (key) return t.key?.toUpperCase() === key;
  const hay = `${t.key ?? ""} ${t.title} ${t.body}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
};

const byRank = (a: Ticket, b: Ticket): number => a.rank - b.rank || a.number - b.number;

export interface Column {
  state: Exclude<TicketState, "dropped">;
  title: string;
  /** The cards shown, top to bottom. */
  cards: Ticket[];
  /** Done only: the settled ones folded away (Done for 3 days, Dropped). */
  shelf: Ticket[];
}

/** Waiting on the person: what's in Review, for them to look at, and what
 *  `needsYou` (its session or agent waits on them). */
export const waitingOnYou = (t: Ticket, needsYou: (t: Ticket) => boolean): boolean =>
  t.state === "review" || (t.state !== "done" && t.state !== "dropped" && needsYou(t));

/** The board's columns as `filter` and `q` show them (and `plan`, the
 *  tickets of the plan chosen, when one is): snoozed tickets hidden,
 *  settled ones on Done's shelf, each column by rank. `waiting` says
 *  whether a ticket's session or agent waits on the person. */
export const columns = (
  tickets: readonly Ticket[],
  opts: { filter: BoardFilter; q: string; now: number; waiting: (t: Ticket) => boolean; plan?: ReadonlySet<string> | null; me?: string | null },
): Column[] => {
  const shown = tickets.filter(
    (t) => !snoozed(t, opts.now) && (!opts.plan || opts.plan.has(t.id)) && matches(t, opts.q) && shownBy(t, opts.filter, opts.waiting, opts.me),
  );
  // One pass into the columns, each then ordered by rank.
  const by = new Map<TicketState, Ticket[]>(COLUMNS.map(({ state }) => [state, []]));
  for (const t of shown) by.get(t.state === "dropped" ? "done" : t.state)?.push(t);
  return COLUMNS.map(({ state, title }) => {
    const mine = by.get(state)!.sort(byRank);
    return state === "done"
      ? { state, title, cards: mine.filter((t) => !settled(t, opts.now)), shelf: mine.filter((t) => settled(t, opts.now)) }
      : { state, title, cards: mine, shelf: [] };
  });
};

/** Where a card dropped at `index` among `column`'s other cards (top to
 *  bottom, the moved one left out) lands: after the card above it
 *  (`before`), ahead of the card below (`after`). */
export const dropAt = (state: TicketState, column: readonly string[], index: number): TicketMove => {
  const i = Math.max(0, Math.min(index, column.length));
  const above = column[i - 1];
  const below = column[i];
  return { state, ...(above ? { before: above } : {}), ...(below ? { after: below } : {}) };
};

/** The move a card's Alt+arrow makes: up or down its column (null at its
 *  end), or to the end of the column beside it (null at the board's edge). */
export const nudge = (cols: readonly Column[], id: string, key: "up" | "down" | "left" | "right"): TicketMove | null => {
  const c = cols.findIndex((col) => col.cards.some((t) => t.id === id));
  if (c < 0) return null;
  const ids = cols[c]!.cards.map((t) => t.id);
  const i = ids.indexOf(id);
  if (key === "up" || key === "down") {
    const to = key === "up" ? i - 1 : i + 1;
    if (to < 0 || to >= ids.length) return null;
    const others = ids.filter((x) => x !== id);
    return dropAt(cols[c]!.state, others, to);
  }
  const next = cols[c + (key === "left" ? -1 : 1)];
  if (!next) return null;
  return dropAt(next.state, next.cards.map((t) => t.id), next.cards.length);
};

/** `t` as it stands once `move` lands, among `all` (for the neighbours'
 *  ranks): shown at once, before the hub answers. Where there's no room
 *  between neighbours the hub's answer places it. */
export const moved = (t: Ticket, move: TicketMove, all: Readonly<Record<string, Ticket>>, now: string): Ticket => {
  const above = move.before ? (all[move.before]?.rank ?? null) : null;
  const below = move.after ? (all[move.after]?.rank ?? null) : null;
  const lastRank = Object.values(all)
    .filter((o) => o.board === t.board && o.state === move.state && o.id !== t.id)
    .reduce<number | null>((m, o) => (m === null ? o.rank : Math.max(m, o.rank)), null);
  const rank = move.before || move.after ? rankBetween(above, below) : rankBetween(lastRank, null);
  const state = move.state;
  return { ...t, state, rank: rank ?? t.rank, stateAt: state === t.state ? t.stateAt : now, updatedAt: now };
};

/** Every ticket's state, by id: worked out once for a board's cards. */
export const statesOf = (all: Readonly<Record<string, Ticket>>): Map<string, TicketState> => new Map(Object.values(all).map((o) => [o.id, o.state] as const));

/** "needs ACM-12, ACM-3": the keys of what it waits on, as the card says. */
export const needsLine = (t: Ticket, all: Readonly<Record<string, Ticket>>, states: ReadonlyMap<string, TicketState> = statesOf(all)): string | null => {
  const keys = blockers(t, states)
    .map((id) => all[id]?.key)
    .filter((k): k is string => !!k);
  return keys.length ? `needs ${keys.join(", ")}` : null;
};

/** The settled shelf's button: "5 more, settled after 3 days". */
export const shelfLabel = (n: number, open: boolean): string =>
  open ? "Fold the settled ones away" : `${n} more, settled after 3 days`;

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One row of a ticket's history: what happened to "it", and a session's
 *  or agent's note in its own words, kept apart from Desk's. */
export interface HistoryLine {
  text: string;
  /** A comment's words, quoted as the commenter's. */
  quote: string | null;
}

/** `e` as a row of ticket `key`'s own history: its key (and the title
 *  quoted after it) is "it"; a comment is "noted", with its words. */
export const historyLine = (e: Pick<ActivityEvent, "kind" | "text" | "detail">, key: string | null): HistoryLine => {
  if (e.kind === "ticket_commented") {
    const quote = e.detail?.comment ?? /“([\s\S]*)”$/.exec(e.text)?.[1] ?? null;
    return { text: "noted", quote };
  }
  const text = key ? e.text.replace(new RegExp(`${escaped(key)}(?: “[^”]*”)?`, "g"), "it") : e.text;
  return { text, quote: null };
};

/** What a ticket's sessions spent on it: the ledger's rows stamped with it. */
export const spendOf = (rows: readonly LedgerRow[], ticket: string): { tokens: number; usd: number; calls: number } =>
  rows
    .filter((r) => r.ticket === ticket)
    .reduce(
      (t, r) => ({ tokens: t.tokens + totalTokens(r.tokens), usd: t.usd + (r.usd ?? 0), calls: t.calls + 1 }),
      { tokens: 0, usd: 0, calls: 0 },
    );

/** The sessions that worked on `t`: its assignee and those linked to it. */
export const sessionsOf = (t: Pick<Ticket, "assignee" | "links">): string[] => [
  ...new Set([
    ...(t.assignee?.kind === "session" ? [t.assignee.id] : []),
    ...t.links.flatMap((l) => (l.kind === "session" ? [l.session] : [])),
  ]),
];

/** Where a dragged card is over: a card (its upper or lower half), or a
 *  column's empty space. */
export type Over = { card: string; upper: boolean } | { column: TicketState };

/** The line a drop at `over` shows: before a card, or at a column's end
 *  (`before` null). */
export const lineAt = (cols: readonly Column[], over: Over): { state: TicketState; before: string | null } | null => {
  if ("column" in over) return { state: over.column, before: null };
  const col = cols.find((c) => c.cards.some((t) => t.id === over.card));
  if (!col) return null;
  const ids = col.cards.map((t) => t.id);
  const i = ids.indexOf(over.card) + (over.upper ? 0 : 1);
  return { state: col.state, before: ids[i] ?? null };
};

/** The move dropping `source` at `over` makes; null where it is already. */
export const landing = (cols: readonly Column[], source: string, over: Over): TicketMove | null => {
  const line = lineAt(cols, over);
  if (!line) return null;
  const col = cols.find((c) => c.state === line.state);
  if (!col) return null;
  const ids = col.cards.map((t) => t.id);
  const from = ids.indexOf(source);
  const others = ids.filter((id) => id !== source);
  const index = line.before === null ? others.length : others.indexOf(line.before);
  if (index < 0) return null;
  if (from >= 0 && from === index) return null;
  return dropAt(col.state, others, index);
};

/** Plain text in parts: its words, and the keys in it of tickets there are
 *  (`known`, upper-case keys), for a chip each. */
export const keyParts = (text: string, known: ReadonlySet<string>): ({ kind: "text"; text: string } | { kind: "key"; key: string })[] => {
  const parts: ({ kind: "text"; text: string } | { kind: "key"; key: string })[] = [];
  let at = 0;
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{1,5}-[1-9]\d*\b/g)) {
    if (!known.has(m[0])) continue;
    if (m.index > at) parts.push({ kind: "text", text: text.slice(at, m.index) });
    parts.push({ kind: "key", key: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
};

/** A move worked out among the cards shown, placed in the whole column
 *  (`tickets`: the board's, the moved one too): between the card it lands
 *  after and the one truly next to it, hidden by a filter or not, so the
 *  hub's rank falls where it was shown. */
export const anchored = (mv: TicketMove, tickets: readonly Ticket[], source: string): TicketMove => {
  const column = tickets
    .filter((t) => t.state === mv.state && t.id !== source)
    .sort(byRank)
    .map((t) => t.id);
  const at = (id: string) => column.indexOf(id);
  if (mv.before && at(mv.before) >= 0) {
    const next = column[at(mv.before) + 1];
    return { state: mv.state, before: mv.before, ...(next ? { after: next } : {}) };
  }
  if (mv.after && at(mv.after) >= 0) {
    const prev = column[at(mv.after) - 1];
    return { state: mv.state, ...(prev ? { before: prev } : {}), after: mv.after };
  }
  const last = column.at(-1);
  return { state: mv.state, ...(last ? { before: last } : {}) };
};

/** Each ticket's plan, by ticket id, from the plans read in full. */
export const planOfTickets = (plans: readonly { id: string; tickets: readonly { id: string }[] }[]): Map<string, string> =>
  new Map(plans.flatMap((p) => p.tickets.map((t) => [t.id, p.id] as const)));
