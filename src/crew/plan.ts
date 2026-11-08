// A boss's plan, as pure functions: its waves and where its tickets stand
// (the same as the hub's `plan::waves` and `plan::progress`, on the shared
// fixtures in `fixtures/plan/`), and what its card says of it. The hub sends
// both with a plan; Desk works them out again over the board's tickets as
// they move, which the hub announces one ticket at a time.

import { amountText } from "../spend/budgets";
import type {
  BossPlan,
  BossPlanDetail,
  BossPlanPaused,
  BossPlanProgress,
  BossPlanRevision,
  BossPlanTicket,
  DraftTicket,
  Engine,
  PlanBudget,
  PlannedTicket,
  Ticket,
  TicketState,
  View,
} from "../hub/types";

/** A plan's ticket as its rules read it: where it stands on the board, and
 *  whether anyone has it. */
export interface PlanTicket {
  id: string;
  key?: string | null;
  state: TicketState;
  rank: number;
  needs: readonly string[];
  engine?: Engine | null;
  folder?: string | null;
  view?: View | null;
  /** A session or an agent has it. */
  assigned?: boolean;
  /** Its session is being started. */
  starting?: boolean;
}

/** Its key, or its id where its board has no keys. */
export const nameOf = (t: Pick<PlanTicket, "id" | "key">): string => t.key ?? t.id;

/** `tickets` by rank, those of equal rank in the order given. */
const byRank = <T extends { rank: number }>(tickets: readonly T[]): T[] =>
  tickets
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.rank - b.t.rank || a.i - b.i)
    .map(({ t }) => t);

/** The layers of the needs graph, each in the order given: a ticket is in
 *  the first layer after every one it needs (a need outside `tickets`
 *  holds nothing back). Those that need each other in a loop, or one that
 *  does, are left over. */
const layers = (tickets: readonly Pick<PlanTicket, "id" | "needs">[]): { waves: string[][]; left: string[] } => {
  const ours = new Set(tickets.map((t) => t.id));
  const placed = new Set<string>();
  const waves: string[][] = [];
  for (;;) {
    const wave = tickets.filter((t) => !placed.has(t.id) && t.needs.every((n) => !ours.has(n) || placed.has(n))).map((t) => t.id);
    if (wave.length === 0) break;
    wave.forEach((id) => placed.add(id));
    waves.push(wave);
  }
  return { waves, left: tickets.filter((t) => !placed.has(t.id)).map((t) => t.id) };
};

/** The waves of a plan's tickets, for showing: the first holds what needs
 *  nothing, each next one what needs only those before. Tickets that need
 *  each other in a loop come last, together, so none is left out. */
export const waves = (tickets: readonly PlanTicket[]): string[][] => {
  const { waves: out, left } = layers(byRank(tickets));
  return left.length > 0 ? [...out, left] : out;
};

/** Whether `t` may start now: in To do, every need Done (a need not among
 *  `states` holds it back), and no one has it or is starting it. */
const startable = (t: PlanTicket, states: ReadonlyMap<string, TicketState>): boolean =>
  t.state === "todo" && !t.assigned && !t.starting && t.needs.every((n) => states.get(n) === "done");

/** Where a plan's tickets stand. */
export const progress = (tickets: readonly PlanTicket[]): BossPlanProgress => {
  const states = new Map(tickets.map((t) => [t.id, t.state]));
  const p: BossPlanProgress = { done: 0, doing: 0, review: 0, ready: 0, blocked: 0, waiting: 0, total: 0, next: [] };
  const next: PlanTicket[] = [];
  for (const t of tickets) {
    switch (t.state) {
      case "dropped":
        continue;
      case "done":
        p.done++;
        break;
      case "review":
        p.review++;
        break;
      case "doing":
        p.doing++;
        break;
      case "todo":
      case "backlog":
        if (t.state === "todo" && (t.starting || t.assigned)) p.doing++;
        else if (t.needs.some((n) => states.get(n) === "dropped")) p.blocked++;
        else if (startable(t, states)) {
          p.ready++;
          next.push(t);
        } else p.waiting++;
        break;
    }
    p.total++;
  }
  p.next = byRank(next).map(nameOf);
  return p;
};

// ── The card ────────────────────────────────────────────────────────────

/** A plan's tickets as they stand now: the hub's, with each one's state,
 *  needs and who has it as the board has heard since. */
export const liveTickets = (plan: Pick<BossPlanDetail, "tickets">, board: Readonly<Record<string, Ticket>>): BossPlanTicket[] =>
  plan.tickets.map((t) => {
    const now = board[t.id];
    return now && now.updatedAt >= t.updatedAt ? { ...t, ...now } : t;
  });

/** `t` as the plan's rules read it. */
export const ruled = (t: BossPlanTicket): PlanTicket => ({
  id: t.id,
  key: t.key,
  state: t.state,
  rank: t.rank,
  needs: t.needs,
  engine: t.engine,
  folder: t.folder,
  view: t.view,
  assigned: !!t.assignee,
  starting: t.starting,
});

/** Whether a revision waits on the person: the first, or a change of scope
 *  since. */
export const awaiting = (p: Pick<BossPlan, "state" | "revision" | "approvedRevision">): boolean =>
  (p.state === "proposed" || p.state === "running" || p.state === "paused") && p.approvedRevision !== p.revision;

/** Why it is paused, as the person reads it after "Paused: ". */
export const PAUSED_WHY: Record<BossPlanPaused, string> = {
  person: "you paused it",
  budget: "its budget is nearly spent",
  boss_held: "its boss is held",
  restoring: "Desk is resuming its sessions",
  no_boss: "its group has no boss",
  start_failing: "its sessions keep failing to start",
};

/** Why `p` is paused, after "Paused: ": the hub's own words when it says
 *  them (a reason Desk doesn't know, such as starts that kept failing),
 *  else Desk's for the reasons it knows, else the reason as named. */
export const pausedWhy = (p: Pick<BossPlan, "paused" | "pausedWhy">): string => {
  if (!p.paused) return "";
  const said = p.pausedWhy?.trim();
  if (said) return said;
  return (PAUSED_WHY as Record<string, string | undefined>)[p.paused] ?? p.paused.replace(/_/g, " ");
};

/** The pauses the person lifts with Resume; the others lift themselves. */
export const resumable = (why: string | null): boolean => why === "person" || why === "no_boss";

/** What a plan's card says it is at, and how it is drawn. */
export const standing = (p: Pick<BossPlan, "state" | "revision" | "approvedRevision">): { text: string; look: "blocked" | "working" | "done" | "idle" } => {
  if (p.state === "proposed") return { text: "Waiting for you", look: "blocked" };
  if (awaiting(p)) return { text: "A change waits for you", look: "blocked" };
  switch (p.state) {
    case "running":
      return { text: "Running", look: "working" };
    case "paused":
      return { text: "Paused", look: "blocked" };
    case "done":
      return { text: "Done", look: "done" };
    default:
      return { text: "Dropped", look: "idle" };
  }
};

/** A wave's heading: the first starts at once (side by side, when it has
 *  more than one); the last of three or more comes last; the rest come
 *  then, after what they wait on that came before. */
export const waveTitle = (
  i: number,
  all: readonly (readonly string[])[],
  tickets: ReadonlyMap<string, Pick<PlanTicket, "id" | "key" | "needs">>,
): { label: string; note: string | null } => {
  const wave = all[i] ?? [];
  if (i === 0) return { label: "Starts at once", note: wave.length > 1 ? `${wave.length} side by side` : null };
  if (i === all.length - 1 && all.length >= 3) return { label: "Last", note: null };
  const here = new Set(wave);
  const after: string[] = [];
  for (const id of wave)
    for (const n of tickets.get(id)?.needs ?? []) {
      const need = tickets.get(n);
      if (need && !here.has(n) && !after.includes(nameOf(need))) after.push(nameOf(need));
    }
  return { label: "Then", note: after.length > 0 ? `after ${after.join(", ")}` : null };
};

/** The tickets that get a worktree of their own: those that run beside an
 *  earlier one of the same wave in the same folder, as the hub's runner
 *  gives them one. */
export const ownWorktrees = (all: readonly (readonly string[])[], tickets: ReadonlyMap<string, Pick<PlanTicket, "folder">>): Set<string> => {
  const own = new Set<string>();
  for (const wave of all) {
    const seen = new Set<string>();
    for (const id of wave) {
      const folder = tickets.get(id)?.folder;
      if (!folder) continue;
      if (seen.has(folder)) own.add(id);
      seen.add(folder);
    }
  }
  return own;
};

/** "3 of 8 done · 3 running · next ACM-16 when a slot frees". */
export const progressLine = (p: BossPlanProgress): string =>
  [
    `${p.done} of ${p.total} done`,
    p.doing > 0 ? `${p.doing} running` : null,
    p.review > 0 ? `${p.review} in review` : null,
    p.next.length > 0 ? `next ${p.next.slice(0, 3).join(", ")} when a slot frees` : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** The bar's segments, in order, with how many each is; none of none. */
export const segments = (p: BossPlanProgress): { kind: "done" | "doing" | "review" | "ready" | "blocked" | "waiting"; n: number }[] =>
  (["done", "doing", "review", "ready", "blocked", "waiting"] as const).map((kind) => ({ kind, n: p[kind] })).filter((s) => s.n > 0);

/** The revision `n` of `p`, when it has it. */
export const revisionOf = (p: Pick<BossPlanDetail, "revisions">, n: number): BossPlanRevision | undefined =>
  p.revisions.find((r) => r.revision === n);

/** A revision's tickets as an edit writes them: by id, with what each
 *  needs by its place in the list. */
export const draftOf = (tickets: readonly PlannedTicket[]): DraftTicket[] => {
  const place = new Map(tickets.map((t, i) => [t.id, i]));
  return tickets.map((t) => ({
    id: t.id,
    title: t.title,
    body: t.body,
    engine: t.engine,
    folder: t.folder,
    view: t.view,
    needs: t.needs.map((n) => place.get(n)).filter((i): i is number => i !== undefined),
  }));
};

/** `tickets` without the one at `i`: what needed it no longer does, and the
 *  places after it move up one. */
export const withoutTicket = (tickets: readonly DraftTicket[], i: number): DraftTicket[] =>
  tickets.filter((_, j) => j !== i).map((t) => ({ ...t, needs: t.needs.filter((n) => n !== i).map((n) => (n > i ? n - 1 : n)) }));

/** The tickets of `tickets` that ticket `i` may need: any but itself and
 *  those that need it, however far along (a need that loops is refused). */
export const needChoices = (tickets: readonly DraftTicket[], i: number): number[] => {
  const needsI = new Set<number>([i]);
  let grew = true;
  while (grew) {
    grew = false;
    tickets.forEach((t, j) => {
      if (!needsI.has(j) && t.needs.some((n) => needsI.has(n))) {
        needsI.add(j);
        grew = true;
      }
    });
  }
  return tickets.map((_, j) => j).filter((j) => !needsI.has(j));
};

/** Whether a ticket has started: past To do, someone has it, or its
 *  session is being started. Where it runs then can't change. */
export const started = (t: Pick<BossPlanTicket, "state" | "assignee" | "starting">): boolean =>
  !!t.assignee || t.starting || (t.state !== "backlog" && t.state !== "todo");

/** Whether `p` has sessions working on it: the drop asks what becomes of
 *  them. */
export const working = (tickets: readonly Pick<BossPlanTicket, "state">[]): boolean => tickets.some((t) => t.state === "doing" || t.state === "review");

/** Which of the plan cards in a conversation shows the plan whole: the
 *  newest one posted for it (the person's own edits and approvals post
 *  none); the others say only what changed. */
export const liveCard = (posted: readonly number[], revision: number): boolean => posted.length === 0 || revision >= Math.max(...posted);

/** A revision's goal, tickets and limit. */
export type PlanSnapshot = BossPlanRevision["snapshot"];

/** What one ticket of a revision changes from the one approved. */
export interface TicketChange {
  ticket: PlannedTicket;
  title?: { from: string; to: string };
  body?: { from: string; to: string };
  engine?: { from: Engine; to: Engine };
  folder?: { from: string; to: string };
  view?: { from: View | null; to: View | null };
  /** What it needs done first, by ticket id: needs it gains and loses. */
  needs?: { added: string[]; dropped: string[] };
}

/** Everything `after` changes from `before`, the revision approved: what
 *  approving it would approve, each part shown in full. */
export interface PlanChanges {
  goal?: { from: string; to: string };
  /** Its limit of sessions at once; null is its boss's. */
  parallel?: { from: number | null; to: number | null };
  /** What it may spend; null is no budget of its own. */
  budget?: { from: PlanBudget | null; to: PlanBudget | null };
  /** The tickets in both, by id, in the order each lists them, when that
   *  changed: what starts first. */
  order?: { from: string[]; to: string[] };
  added: PlannedTicket[];
  removed: PlannedTicket[];
  changed: TicketChange[];
}

export const changesBetween = (before: PlanSnapshot, after: PlanSnapshot): PlanChanges => {
  const was = new Map(before.tickets.map((t) => [t.id, t]));
  const now = new Set(after.tickets.map((t) => t.id));
  const changed: TicketChange[] = [];
  for (const t of after.tickets) {
    const w = was.get(t.id);
    if (!w) continue;
    const c: TicketChange = { ticket: t };
    if (w.title !== t.title) c.title = { from: w.title, to: t.title };
    if (w.body !== t.body) c.body = { from: w.body, to: t.body };
    if (w.engine !== t.engine) c.engine = { from: w.engine, to: t.engine };
    if (w.folder !== t.folder) c.folder = { from: w.folder, to: t.folder };
    if ((w.view ?? null) !== (t.view ?? null)) c.view = { from: w.view ?? null, to: t.view ?? null };
    const added = t.needs.filter((n) => !w.needs.includes(n));
    const dropped = w.needs.filter((n) => !t.needs.includes(n));
    if (added.length || dropped.length) c.needs = { added, dropped };
    if (c.title || c.body || c.engine || c.folder || c.view || c.needs) changed.push(c);
  }
  const from = before.parallel ?? null;
  const to = after.parallel ?? null;
  const kept = (s: PlanSnapshot) => s.tickets.map((t) => t.id).filter((id) => was.has(id) && now.has(id));
  const order = { from: kept(before), to: kept(after) };
  return {
    ...(before.goal.trim() !== after.goal.trim() ? { goal: { from: before.goal, to: after.goal } } : {}),
    ...(from !== to ? { parallel: { from, to } } : {}),
    ...(JSON.stringify(before.budget ?? null) !== JSON.stringify(after.budget ?? null) ? { budget: { from: before.budget ?? null, to: after.budget ?? null } } : {}),
    ...(order.from.join() !== order.to.join() ? { order } : {}),
    added: after.tickets.filter((t) => !was.has(t.id)),
    removed: before.tickets.filter((t) => !now.has(t.id)),
    changed,
  };
};

/** Whether a DM message's text is only its plan card's own header, as the
 *  hub writes it when a boss proposes or changes a plan: the card says all
 *  of it. Anything else the boss says (its closing summary) is its own. */
export const isCardText = (text: string): boolean =>
  /^[^\n]{1,80}? (proposes a plan|changed the plan|proposes a change to the plan): /.test(text.trim());

/** How often a plan's budget starts again, as said after its amount. */
const PER: Record<PlanBudget["period"], string> = {
  total: "for the whole plan",
  five_hours: "per five hours",
  day: "a day",
  week: "a week",
  month: "a month",
};

/** What a plan may spend, all of it: "$40 for the whole plan, warns at
 *  80%, pauses new starts when over"; "$10 per five hours, warns at 90%,
 *  only tells you when over". */
export const budgetText = (b: PlanBudget): string =>
  `${amountText(b.unit, b.amount)} ${PER[b.period]}, warns at ${Math.round(b.warnAt * 100)}%, ${
    b.onExceed === "pause" ? "pauses new starts when over" : "only tells you when over"
  }`;

/** The person's own cap of `amount` dollars on a plan: over the proposal's
 *  period (else the whole run), warning at `warnAt` and doing `onExceed`
 *  over it (80% and pause unless they chose otherwise). */
export const capOf = (
  amount: number,
  proposed: PlanBudget | null | undefined,
  choice: { warnAt?: number; onExceed?: PlanBudget["onExceed"] } = {},
): PlanBudget => ({
  amount,
  unit: "usd",
  period: proposed && proposed.unit === "usd" ? proposed.period : "total",
  warnAt: choice.warnAt ?? 0.8,
  onExceed: choice.onExceed ?? "pause",
});

/** Whether two budgets are the same in every part. */
export const sameBudget = (a: PlanBudget | null | undefined, b: PlanBudget | null | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
