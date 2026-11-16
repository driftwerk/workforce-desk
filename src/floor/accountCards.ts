// The Plans board: one card per real account, Claude or ChatGPT, saying
// every place it is used. This computer's cards are `plans`' (its accounts,
// its own sign-in, its CLIs'); a machine's readings join the card of the
// account they were copied from, matched as Desk copies them (identity, else
// name), never by their numbers; a hub's join a card when they name its
// account, or when the person said which account they are. The rest wait
// in "Not matched", one row a place. Nothing is ever guessed from resets.

import { sameAccountIn } from "../engines/standing";
import type { EngineAccount, PlanKind, PlanReading } from "../hub/types";
import { shift } from "./merge";
import { KINDS, plans, type PlanCard, type PlanSource } from "./usage";

const MINUTE = 60_000;

/** One hub's usage, and the machine it is the engine of, if any. */
export interface Source extends PlanSource {
  machine?: string;
}

/** What the person said of a hub's place: the card it is on, or don't ask. */
export type Link = { account: string } | { hidden: true; label: string };

/** An account the person named for a hub's place ("Another account"). */
export interface Other {
  key: string;
  kind: PlanKind;
  name: string;
}

/** What the person said, kept in Desk's own store (`ui.plans`). */
export interface Links {
  links: Readonly<Record<string, Link>>;
  others: readonly Other[];
}

export const NO_LINKS: Links = { links: {}, others: [] };

/** One place an account is used. */
export interface UsedOn {
  /** The place's key: for a hub's, what a link is kept under. */
  key: string;
  where: "computer" | "machine" | "hub";
  /** "This computer", "devbox", "Driftwerk". */
  label: string;
  /** The sessions on it there now, where the place says. */
  sessions: number | null;
  /** In this computer's time. */
  reading: PlanReading | null;
  /** The person linked it: it can be unlinked. */
  picked: boolean;
}

/** One account's card. */
export interface AccountCard extends PlanCard {
  /** Its name: an account's, a machine's own or the person's; none: worded
   *  from where it is (this computer's sign-in, its CLI's). */
  name: string | null;
  isDefault: boolean;
  usedOn: UsedOn[];
  /** Its places' readings can't all be one account's. */
  conflict: boolean;
}

/** A hub's place that names no account the person has said. */
export interface Unmatched {
  key: string;
  kind: PlanKind;
  label: string;
  plan: string | null;
  reading: PlanReading;
}

export interface Board {
  cards: AccountCard[];
  unmatched: Unmatched[];
}

export interface Inputs {
  sources: readonly Source[];
  /** This computer's accounts. */
  accounts: readonly EngineAccount[];
  /** The key of this computer's own sign-in's plan, when known. */
  ownKey: string | null;
  /** A machine's accounts, as its hub lists them. */
  machineAccounts: (machine: string) => readonly EngineAccount[];
  links: Links;
}

const NAME: Record<PlanKind, string> = { claude: "Claude", chatgpt: "ChatGPT" };

const kindOf = (a: EngineAccount): PlanKind => (a.engine === "codex" ? "chatgpt" : "claude");

/** The card key an account's readings are kept under. */
export const cardKeyOf = (a: EngineAccount): string | null => (a.planKey ? `${kindOf(a)}:${a.planKey}` : null);

/** A hub's place: one login of one kind there. */
export const placeKey = (hubId: string, r: Pick<PlanReading, "kind" | "account" | "login">): string =>
  `${r.kind}@${hubId}:${r.account ?? r.login ?? ""}`;

const shifted = (r: PlanReading, offset: number): PlanReading => ({
  ...r,
  observedAt: shift(r.observedAt, offset),
  windows: r.windows.map((w) => ({ ...w, resetsAt: w.resetsAt === null ? null : shift(w.resetsAt, offset) })),
});

const newestFirst = (a: PlanReading, b: PlanReading) => b.observedAt.localeCompare(a.observedAt);

/** How far apart two readings' resets may be and still be one window's. */
const SAME_RESET_MS = 10 * MINUTE;
/** How far a later reading may be below an earlier one of the same window:
 *  a hub writes again only once a window moves a point. */
const DROP = 2;

/** Whether readings from different places can't all be one account's: one
 *  window resetting at two times at once, or a later reading of the same
 *  window below an earlier one. An older reading lower than a newer one is
 *  only an older reading. */
export const disagree = (readings: readonly PlanReading[]): boolean => {
  const ws = readings.flatMap((r) =>
    r.windows.flatMap((w) => (w.resetsAt === null ? [] : [{ minutes: w.minutes, used: w.usedPercent, reset: Date.parse(w.resetsAt), at: Date.parse(r.observedAt), r }])),
  );
  for (const [i, a] of ws.entries())
    for (const b of ws.slice(i + 1)) {
      if (a.r === b.r || a.minutes !== b.minutes) continue;
      const apart = Math.abs(a.reset - b.reset);
      if (apart <= SAME_RESET_MS) {
        const [older, later] = a.at <= b.at ? [a, b] : [b, a];
        if (later.used < older.used - DROP) return true;
        // Back-to-back windows reset one length apart: give or take the
        // places' clocks, that's an older week's reading, not a clash.
      } else if (apart < a.minutes * MINUTE - SAME_RESET_MS) return true;
    }
  return false;
};

interface Place {
  key: string;
  source: Source;
  reading: PlanReading;
}

/** Each remote hub's places, its newest reading each; of a hub's logins of
 *  one kind that name no account, only the one heard from last. */
const placesOf = (s: Source): Place[] => {
  const newest = new Map<string, PlanReading>();
  for (const r of s.usage.readings.map((r) => shifted(r, s.offset)).sort(newestFirst)) {
    const key = placeKey(s.hubId, r);
    if (!newest.has(key)) newest.set(key, r);
  }
  const all = [...newest].map(([key, reading]) => ({ key, source: s, reading }));
  return all.filter(
    (p) => p.reading.account || !all.some((q) => q !== p && !q.reading.account && q.reading.kind === p.reading.kind && q.reading.observedAt > p.reading.observedAt),
  );
};

/** The board, from every hub's readings and what the person said. */
export const board = ({ sources, accounts, ownKey, machineAccounts, links }: Inputs): Board => {
  const local = sources.filter((s) => s.local);
  const keys = accounts.flatMap((a) => cardKeyOf(a) ?? []);
  const base = plans(local, { accounts: keys, own: ownKey });
  const cards = new Map<string, AccountCard>();
  // Which card a reading's account is on.
  const byAccount = new Map<string, string>();
  for (const c of base) {
    const account = accounts.find((a) => cardKeyOf(a) === c.key) ?? null;
    cards.set(c.key, {
      ...c,
      name: account?.name ?? null,
      isDefault: account?.isDefault ?? false,
      usedOn:
        c.state === "signed-out" ? [] : [{ key: `local:${c.key}`, where: "computer", label: "This computer", sessions: account ? account.sessions.length : null, reading: c.reading, picked: false }],
      conflict: false,
    });
    if (c.state === "signed-out") continue;
    if (account || c.key === ownKey) byAccount.set(c.key, c.key);
    if (c.reading?.account) byAccount.set(`${c.kind}:${c.reading.account}`, c.key);
  }
  const others = new Map(links.others.map((o) => [o.key, o]));
  const unmatched: Unmatched[] = [];
  const put = (key: string, row: UsedOn, make: () => Omit<AccountCard, "usedOn" | "conflict">) => {
    const card = cards.get(key) ?? { ...make(), usedOn: [], conflict: false };
    card.usedOn.push(row);
    cards.set(key, card);
  };
  const remote = (key: string, kind: PlanKind, name: string, hub: string) => (): Omit<AccountCard, "usedOn" | "conflict"> => ({
    key,
    kind,
    name,
    isDefault: false,
    plan: null,
    where: hub,
    hub,
    computer: false,
    state: "reading",
    reading: null,
  });
  // Machines first: a hub's reading naming an account only a machine has
  // joins that machine's card.
  const remotes = sources.filter((s) => !s.local).sort((a, b) => Number(!a.machine) - Number(!b.machine));
  for (const s of remotes)
    for (const { key, reading: r } of placesOf(s)) {
      const named = r.account ? byAccount.get(`${r.kind}:${r.account}`) : undefined;
      if (s.machine) {
        // Its accounts were picked when it was added: copied from this
        // computer's, so they are those accounts' cards.
        const there = machineAccounts(s.machine).find((a) => a.planKey && a.planKey === r.account && kindOf(a) === r.kind) ?? null;
        const mine = there && sameAccountIn(there, accounts);
        const onto = named ?? (mine && cardKeyOf(mine) && cards.has(cardKeyOf(mine)!) ? cardKeyOf(mine)! : undefined);
        if (!onto && !there && r.where === "hub") continue;
        const row: UsedOn = { key, where: "machine", label: s.label, sessions: there ? there.sessions.length : null, reading: r, picked: false };
        // None of this computer's: a card of its own, one an account
        // wherever it's used.
        const own = onto ?? (r.account ? `${r.kind}:${r.account}` : key);
        put(own, row, remote(own, r.kind, `${there?.name ?? NAME[r.kind]} on ${s.label}`, s.label));
        if (r.account) byAccount.set(`${r.kind}:${r.account}`, own);
        continue;
      }
      const row: UsedOn = { key, where: "hub", label: s.label, sessions: null, reading: r, picked: false };
      if (named) {
        put(named, row, remote(named, r.kind, NAME[r.kind], s.label));
        continue;
      }
      const link = links.links[key];
      if (link && "hidden" in link) continue;
      // Onto the card the person said, while it is there and of its kind.
      if (link && (cards.get(link.account)?.kind ?? others.get(link.account)?.kind) === r.kind) {
        put(link.account, { ...row, picked: true }, remote(link.account, r.kind, others.get(link.account)?.name ?? NAME[r.kind], s.label));
        continue;
      }
      unmatched.push({ key, kind: r.kind, label: s.label, plan: r.plan, reading: r });
    }
  const out = [...cards.values()].map((c): AccountCard => {
    const readings = c.usedOn.flatMap((u) => u.reading ?? []).sort(newestFirst);
    const top = readings[0] ?? c.reading;
    return {
      ...c,
      reading: top,
      state: top ? "reading" : c.state,
      plan: c.plan ?? readings.find((r) => r.plan)?.plan ?? null,
      conflict: c.usedOn.length > 1 && disagree(readings),
    };
  });
  // Signing in here is offered for a kind no place uses.
  const used = new Set([...out.filter((c) => c.state !== "signed-out").map((c) => c.kind), ...unmatched.map((u) => u.kind)]);
  const shown = out.filter((c) => c.state !== "signed-out" || !used.has(c.kind));
  // This computer's first, then a machine's or hub's own, Claude before ChatGPT.
  const rank = (c: AccountCard) => KINDS.indexOf(c.kind) * 2 + (c.hub === null ? 0 : 1);
  return {
    cards: shown.sort((a, b) => rank(a) - rank(b)),
    unmatched: unmatched.sort((a, b) => a.label.localeCompare(b.label) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)),
  };
};
