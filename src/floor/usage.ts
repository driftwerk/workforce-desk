import type { PlanKind, PlanReading, PlanWindow, UsageView } from "../hub/types";
import { shift } from "./merge";

/** One hub's usage, as read. */
export interface PlanSource {
  hubId: string;
  label: string;
  local: boolean;
  usage: UsageView;
  /** The hub's clock less this computer's. */
  offset: number;
}

/** One plan's card: one of the person's accounts, this computer's own
 *  sign-in, or a remote hub's own plan; its freshest reading wherever it
 *  came from, none yet, or (on this computer) no sign-in at all. */
export interface PlanCard {
  key: string;
  kind: PlanKind;
  plan: string | null;
  /** Where its reading came from: "this computer", or a remote hub's name. */
  where: string;
  /** A remote hub's own plan (a login of its own, none of the person's
   *  accounts): that hub's name. */
  hub: string | null;
  /** This computer's own CLI sign-in, none of the person's accounts. */
  computer: boolean;
  state: "reading" | "no-reading" | "signed-out";
  /** In this computer's time. */
  reading: PlanReading | null;
}

/** The person's plans, by the keys of their cards (`claude:<planKey>`):
 *  their accounts', and this computer's own sign-in's when known. */
export interface Mine {
  accounts: readonly string[];
  own: string | null;
}

export const KINDS: readonly PlanKind[] = ["claude", "chatgpt"];

const whereOf = (s: PlanSource): string => (s.local ? "this computer" : s.label);

const shifted = (r: PlanReading, offset: number): PlanReading => ({
  ...r,
  observedAt: shift(r.observedAt, offset),
  windows: r.windows.map((w) => ({ ...w, resetsAt: w.resetsAt === null ? null : shift(w.resetsAt, offset) })),
});

interface Seen {
  reading: PlanReading;
  where: string;
  source: PlanSource;
}

type Owner = Pick<PlanCard, "hub" | "computer">;

const NOBODY: Owner = { hub: null, computer: false };

/** The cards for every hub's readings, never one that says no one's:
 *  - one for each of the person's accounts (`mine`), whichever login of it
 *    reported, the freshest shown, or waiting for a first reading; and this
 *    computer's own sign-in's;
 *  - a remote hub's reading of no plan of the person's is that hub's own
 *    plan, one card a login (of those that name no account, only the one
 *    heard from last: the hub's login now, not the ones it held before);
 *  - this computer's reading of another sign-in of its CLIs is "on this
 *    computer"; one that names no account joins this computer's sign-in's
 *    card, else has none; the local hub's own calls on a login none of the
 *    accounts is known to be never have one;
 *  - a kind with no card has one while some login of it is signed in, or on
 *    this computer while none is. */
export const plans = (sources: readonly PlanSource[], mine: Mine = { accounts: [], own: null }): PlanCard[] => {
  const seen: Seen[] = sources.flatMap((s) => s.usage.readings.map((r) => ({ reading: shifted(r, s.offset), where: whereOf(s), source: s })));
  const known = new Set([...mine.accounts, ...(mine.own ? [mine.own] : [])]);
  const groups = new Map<string, Seen[]>();
  const owners = new Map<string, Owner>();
  const put = (key: string, x: Seen, owner: Owner) => {
    groups.set(key, [...(groups.get(key) ?? []), x]);
    owners.set(key, owner);
  };
  for (const x of seen) {
    const { kind, account } = x.reading;
    const key = account ? `${kind}:${account}` : null;
    if (key && known.has(key)) put(key, x, NOBODY);
    else if (!x.source.local) put(`${kind}@${x.source.hubId}:${account ?? x.reading.login ?? ""}`, x, { hub: x.source.label, computer: false });
    else if (x.reading.where === "hub") continue;
    else if (account) put(`${kind}@computer`, x, { hub: null, computer: true });
  }
  // This computer's readings that name no account: its own sign-in's,
  // once that has a card; never guessed onto an account's.
  const own = mine.own;
  if (own && groups.has(own))
    for (const x of seen)
      if (!x.reading.account && x.source.local && x.reading.where !== "hub" && x.reading.kind === "claude") put(own, x, NOBODY);
  const newestOf = (xs: readonly Seen[]) => [...xs].sort((a, b) => b.reading.observedAt.localeCompare(a.reading.observedAt));
  // Of a remote hub's logins that name no account, only the one heard
  // from last.
  const unnamed = [...groups].filter(([key, xs]) => owners.get(key)!.hub !== null && !xs[0]!.reading.account);
  for (const [key, xs] of unnamed) {
    const rival = unnamed.find(
      ([k, ys]) =>
        k !== key &&
        ys[0]!.source.hubId === xs[0]!.source.hubId &&
        ys[0]!.reading.kind === xs[0]!.reading.kind &&
        newestOf(ys)[0]!.reading.observedAt > newestOf(xs)[0]!.reading.observedAt,
    );
    if (rival) groups.delete(key);
  }
  const cards: PlanCard[] = [...groups].map(([key, xs]) => {
    const newest = newestOf(xs);
    const top = newest[0]!;
    return {
      key,
      kind: top.reading.kind,
      plan: newest.find((x) => x.reading.plan)?.reading.plan ?? null,
      where: top.where,
      ...owners.get(key)!,
      state: "reading",
      reading: top.reading,
    };
  });
  const waiting = mine.accounts
    .filter((key) => !groups.has(key))
    .flatMap((key): PlanCard[] => {
      const kind = KINDS.find((k) => key.startsWith(`${k}:`));
      return kind ? [{ key, kind, plan: null, where: "this computer", ...NOBODY, state: "no-reading", reading: null }] : [];
    });
  const all = [...cards, ...waiting];
  const empty = KINDS.filter((kind) => !all.some((c) => c.kind === kind)).flatMap((kind): PlanCard[] => {
    const signedIn = sources.find((s) => s.usage.logins.some((l) => l.kind === kind && l.signedIn));
    const here = { hub: null, computer: true };
    if (signedIn)
      return [
        {
          key: `${kind}@none`,
          kind,
          plan: null,
          where: whereOf(signedIn),
          ...(signedIn.local ? here : { hub: signedIn.label, computer: false }),
          state: "no-reading",
          reading: null,
        },
      ];
    return sources.some((s) => s.local)
      ? [{ key: `${kind}@out`, kind, plan: null, where: "this computer", ...here, state: "signed-out", reading: null }]
      : [];
  });
  // A remote hub's own plan after the person's own.
  const rank = (c: PlanCard) => KINDS.indexOf(c.kind) * 2 + (c.hub === null ? 0 : 1);
  return [...all, ...empty].sort((a, b) => rank(a) - rank(b));
};

export type Fullness = "ok" | "high" | "full";

export const fullness = (percent: number): Fullness => (percent < 60 ? "ok" : percent < 90 ? "high" : "full");

const MINUTE = 60_000;

const resetMs = (w: PlanWindow): number | null => (w.resetsAt === null ? null : Date.parse(w.resetsAt));

const startMs = (w: PlanWindow): number | null => {
  const reset = resetMs(w);
  return reset === null ? null : reset - w.minutes * MINUTE;
};

/** A window as it stands now: a reading from before its window reset counts
 *  for nothing, never for the percentage it had then. `resetAt` is when it
 *  resets, or, once it has, when it did. */
export const windowNow = (w: PlanWindow, observedAt: string, now: number): { used: number; resetAt: number | null; reset: boolean } => {
  const resetAt = resetMs(w);
  const start = startMs(w);
  const reset = resetAt !== null && (resetAt <= now || (start !== null && Date.parse(observedAt) < start));
  return { used: reset ? 0 : w.usedPercent, resetAt: reset && resetAt > now ? start : resetAt, reset };
};

/** How far through its window an even pace would be: 0 to 1. */
export const pace = (w: PlanWindow, now: number): number | null => {
  const start = startMs(w);
  return start === null ? null : Math.min(1, Math.max(0, (now - start) / (w.minutes * MINUTE)));
};

/** When the window fills at the rate it has been used, if before it resets;
 *  nothing until enough of it has passed to tell. */
export const projection = (w: PlanWindow, now: number): { hitsAt: number } | { atLimit: true } | null => {
  const resetAt = resetMs(w);
  const start = startMs(w);
  if (resetAt === null || start === null || resetAt <= now) return null;
  if (w.usedPercent >= 100) return { atLimit: true };
  const elapsed = now - start;
  if (w.usedPercent <= 0 || elapsed < Math.max(0.1 * w.minutes * MINUTE, 15 * MINUTE)) return null;
  const hitsAt = now + (100 - w.usedPercent) / (w.usedPercent / elapsed);
  return hitsAt < resetAt ? { hitsAt } : null;
};

/** The next time a card changes by itself: the soonest reset still to come. */
export const nextChange = (cards: readonly PlanCard[], now: number): number | null =>
  cards
    .flatMap((c) => c.reading?.windows ?? [])
    .map(resetMs)
    .filter((t): t is number => t !== null && t > now)
    .reduce<number | null>((soonest, t) => (soonest === null || t < soonest ? t : soonest), null);
