// The board's decisions, as pure functions over tickets: its five columns,
// what each filter and search shows, what's settled or snoozed now, what a
// ticket waits on, and where a dropped card lands. The hub computes `ready`,
// `blockers`, `settled` and `snoozed` as it sends a ticket; these say the
// same of the tickets as they stand now (a need done since, three days gone
// by) without asking it again.

import { shownByFacets, type Facets } from "./facets";
import type { ActivityEvent, BoardSync, LedgerRow, Session, Ticket, TicketMove, TicketState } from "../hub/types";
import { totalTokens } from "../spend/spend";

/** The columns, left to right; Dropped has none and folds under Done. */
export const COLUMNS: readonly { state: Exclude<TicketState, "dropped">; title: string }[] = [
  { state: "backlog", title: "Backlog" },
  { state: "todo", title: "To do" },
  { state: "doing", title: "Doing" },
  { state: "review", title: "Review" },
  { state: "done", title: "Done" },
];

/** What a board's menu can do, each with a dialog of its own. */
export type BoardAction = "rename" | "delete" | "link" | "unlink" | "fromSystem";

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

/** A GitHub issue as typed: `web#12`, or `acme/web#12`. */
const GH_REF = /^(?:([A-Za-z0-9][A-Za-z0-9-]*)\/)?([A-Za-z0-9._-]+)#(\d+)$/;

/** What a typed key asks for, as a test on a ticket's key: `ACM-12` exactly
 *  (any case), or a GitHub issue by `repo#12` (the key's end, owner left
 *  out) or `owner/repo#12`; null when `q` isn't a key. */
export const keyTest = (q: string): ((key: string | null | undefined) => boolean) | null => {
  const k = keyOf(q);
  if (k) return (key) => key?.toUpperCase() === k;
  const m = GH_REF.exec(q.trim());
  if (!m || Number(m[3]) <= 0) return null;
  const want = `${m[1] ? `${m[1]}/` : ""}${m[2]}#${Number(m[3])}`.toLowerCase();
  return (key) => {
    const have = key?.toLowerCase();
    return !!have && (m[1] ? have === want : have === want || have.endsWith(`/${want}`));
  };
};

/** Whether `t` is what `q` asks for: its key when `q` is one (exactly), else
 *  every word somewhere in its key, title or description. */
export const matches = (t: Pick<Ticket, "key" | "title" | "body">, q: string): boolean => {
  const query = q.trim();
  if (!query) return true;
  const isKey = keyTest(query);
  if (isKey) return isKey(t.key);
  const hay = `${t.key ?? ""} ${t.title} ${t.body}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
};

const byRank = (a: Ticket, b: Ticket): number => a.rank - b.rank || a.number - b.number;

/** The order a board's columns show their cards in: as its Jira or Linear
 *  has them (`source`, a synced board's), by when they were made or last
 *  changed, or as the person arranged them (`arranged`, a Desk-only
 *  board's, by rank). */
export type BoardOrder = "source" | "newest" | "oldest" | "changed" | "arranged";

/** Whether a synced board's source keeps an order of its own: Jira's rank,
 *  Linear's sort order, a GitHub project's item order. A GitHub repository's
 *  issues have none. */
export const hasUpstreamOrder = (sync: BoardSync | null | undefined): boolean => !!sync && (sync.system !== "github" || sync.target.includes("/projects/"));

/** The orders a board offers, in its menu's order: a synced board's own
 *  first (where its source has one: `upstream`), a Desk-only board's hand
 *  order last. */
export const ordersFor = (synced: boolean, upstream: boolean = synced): readonly BoardOrder[] =>
  synced ? (upstream ? ["source", "newest", "oldest", "changed"] : ["newest", "oldest", "changed"]) : ["newest", "oldest", "changed", "arranged"];

/** What a board shows until the person picks: as on its Jira or Linear,
 *  else newest first. */
export const defaultOrder = (synced: boolean, upstream: boolean = synced): BoardOrder => (synced && upstream ? "source" : "newest");

/** `order` where the board offers it, else the board's default (a board
 *  linked or unlinked since it was picked, or a repository's, which has no
 *  order of its own to keep). */
export const orderOn = (order: BoardOrder | undefined, synced: boolean, upstream: boolean = synced): BoardOrder =>
  order && ordersFor(synced, upstream).includes(order) ? order : defaultOrder(synced, upstream);

/** Whether a drag up or down a column moves the card in `order`; in the
 *  sorted ones a card's place is its date, so a drag only changes its
 *  column. */
export const byHand = (order: BoardOrder): boolean => order === "source" || order === "arranged";

const ms = (iso: string | null | undefined): number => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(n) ? 0 : n;
};

/** When a ticket was made: its issue's own date on a synced board (the
 *  ticket here was made when it was imported), else the ticket's. */
export const createdOf = (t: Pick<Ticket, "createdAt" | "external">): string => t.external?.details?.created ?? t.createdAt;

/** Its issue's place on its Jira or Linear board: Jira's rank (compared as
 *  text, byte by byte) or Linear's sort order (a number). */
const byUpstream = (a: Ticket, b: Ticket): number => {
  const x = a.upstreamRank ?? null;
  const y = b.upstreamRank ?? null;
  if (x === null || y === null) return x === y ? byRank(a, b) : x === null ? 1 : -1;
  if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
  const d = typeof x === "number" ? x - (y as number) : x < y ? -1 : x > y ? 1 : 0;
  return d || byRank(a, b);
};

/** How `order` sorts a column's cards, top first. */
export const sortFor = (order: BoardOrder): ((a: Ticket, b: Ticket) => number) => {
  switch (order) {
    case "source":
      return byUpstream;
    case "newest":
      return (a, b) => ms(createdOf(b)) - ms(createdOf(a)) || b.number - a.number;
    case "oldest":
      return (a, b) => ms(createdOf(a)) - ms(createdOf(b)) || a.number - b.number;
    case "changed":
      return (a, b) => ms(b.updatedAt) - ms(a.updatedAt) || b.number - a.number;
    case "arranged":
      return byRank;
  }
};

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
  opts: {
    filter: BoardFilter;
    q: string;
    now: number;
    waiting: (t: Ticket) => boolean;
    plan?: ReadonlySet<string> | null;
    me?: string | null;
    /** A synced board's own filters: epic, type, sprint, project, label. */
    facets?: Facets;
    /** How each column is sorted; by rank when not said. */
    order?: BoardOrder;
  },
): Column[] => {
  const shown = tickets.filter(
    (t) =>
      !snoozed(t, opts.now) &&
      (!opts.plan || opts.plan.has(t.id)) &&
      matches(t, opts.q) &&
      shownBy(t, opts.filter, opts.waiting, opts.me) &&
      shownByFacets(t, opts.facets),
  );
  // One pass into the columns, each then sorted in the board's order.
  const by = new Map<TicketState, Ticket[]>(COLUMNS.map(({ state }) => [state, []]));
  for (const t of shown) by.get(t.state === "dropped" ? "done" : t.state)?.push(t);
  const sort = sortFor(opts.order ?? "arranged");
  return COLUMNS.map(({ state, title }) => {
    const mine = by.get(state)!.sort(sort);
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

/** What dropping `source` at `over` does in a sorted order, where a card's
 *  place is its date: it moves to another column (where it shows in its
 *  sorted place), or, dropped in its own, it stays (`sorted`: the board
 *  says why). Null where there's nothing to drop on. */
export const sortedLanding = (cols: readonly Column[], source: Pick<Ticket, "state">, over: Over): TicketMove | "sorted" | null => {
  const to = lineAt(cols, over)?.state;
  if (!to || source.state === "dropped") return null;
  return to === source.state ? "sorted" : { state: to };
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
export const anchored = (mv: TicketMove, tickets: readonly Ticket[], source: string, order: BoardOrder = "arranged"): TicketMove => {
  const column = tickets
    .filter((t) => t.state === mv.state && t.id !== source)
    .sort(sortFor(order))
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

/** A short name for a session started on ticket `t`: its key and the first
 *  few words of its title (`ACM-12 Fix flaky payment`), not the whole title. */
export const sessionNameFor = (t: Pick<Ticket, "key" | "title">, words = 3, max = 32): string => {
  const first = t.title.trim().split(/\s+/).filter(Boolean);
  let name = "";
  for (const w of first.slice(0, words)) {
    const next = name ? `${name} ${w}` : w;
    if (t.key && `${t.key} ${next}`.length > max && name) break;
    name = next;
  }
  const full = [t.key, name].filter(Boolean).join(" ");
  return full.length > max + 8 ? `${full.slice(0, max + 7)}…` : full;
};

/** The folders sessions worked in, newest first, each once: what Start a
 *  session offers before anything is typed. */
export const recentFolders = (sessions: readonly Pick<Session, "cwd" | "updatedAt">[], max = 5): string[] => {
  const seen = new Set<string>();
  for (const s of [...sessions].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))) {
    const dir = s.cwd?.trim().replace(/\/+$/, "");
    if (dir) seen.add(dir);
  }
  return [...seen].slice(0, max);
};

/** The folder and engine a session on a board starts with: those of the
 *  newest session that worked on the ticket, else on any of the board's
 *  tickets, else what the board's last start used, else the newest session
 *  Desk has. Nothing is typed unless there is nothing to go by. */
export const startDefaults = (
  ticket: Pick<Ticket, "assignee" | "links">,
  boardTickets: readonly Pick<Ticket, "assignee" | "links">[],
  sessions: Readonly<Record<string, Pick<Session, "cwd" | "engine" | "updatedAt">>>,
  stored: { cwd: string; engine: string } | null,
): { cwd: string; engine: string | null } => {
  const newest = (ids: readonly string[]) =>
    ids
      .map((id) => sessions[id])
      .filter((s): s is NonNullable<typeof s> => !!s?.cwd)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
  const own = newest(sessionsOf(ticket));
  if (own) return { cwd: own.cwd, engine: own.engine };
  const board = newest(boardTickets.flatMap((x) => sessionsOf(x)));
  if (board) return { cwd: board.cwd, engine: board.engine };
  if (stored?.cwd) return { cwd: stored.cwd, engine: stored.engine };
  const any = newest(Object.keys(sessions));
  return { cwd: any?.cwd ?? "", engine: any?.engine ?? null };
};

/** Where a ticket's session starts, as the ticket and the board's last start
 *  say: the ticket's own machine, folder, engine and model when a plan gave it
 *  them, else the board's last start's (machine and model too), else this
 *  computer. The folder is that machine's own path. */
export interface StartOn {
  machine: string;
  /** A folder on `machine` to start with; "" is nothing to go by. */
  folder: string;
  engine: string | null;
  model: string | null;
}
export const startOn = (
  plan: { machine?: string | null; folder?: string | null; engine?: string | null; model?: string | null } | null | undefined,
  stored: { cwd: string; engine: string; machine?: string; model?: string } | null,
  local: { cwd: string; engine: string | null },
): StartOn => {
  if (plan?.machine) return { machine: plan.machine, folder: plan.folder ?? "", engine: plan.engine ?? null, model: plan.model ?? null };
  if (plan?.model || plan?.folder) {
    return { machine: "local", folder: plan.folder ?? local.cwd, engine: plan.engine ?? local.engine, model: plan.model ?? null };
  }
  if (stored?.machine) return { machine: stored.machine, folder: stored.cwd, engine: stored.engine, model: stored.model ?? null };
  const engine = local.engine;
  return { machine: "local", folder: local.cwd, engine, model: stored?.model && stored.engine === engine ? stored.model : null };
};
