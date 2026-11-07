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

/** One plan account's card: its freshest reading wherever it came from; a
 *  login with none yet; or, on this computer, no sign-in at all. */
export interface PlanCard {
  key: string;
  kind: PlanKind;
  plan: string | null;
  /** Where its reading came from: "this computer", or a remote hub's name. */
  where: string;
  /** A remote hub's own plan (its own login, none of the person's
   *  accounts): that hub's name. */
  hub: string | null;
  state: "reading" | "no-reading" | "signed-out";
  /** In this computer's time. */
  reading: PlanReading | null;
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

/** The cards for every hub's readings, one per account the person has:
 *  - an account's readings, through whichever of its logins, are its card,
 *    the freshest shown; each of the person's accounts (`accounts`: its
 *    card's key, `claude:<planKey>`) has its card, waiting for a reading
 *    until one comes;
 *  - a reading that names no account is no account's: this computer's
 *    joins the only card of its kind with readings, else has none (the local hub's own
 *    calls, on a login none of the accounts is known to be, never do); a
 *    remote hub's is that hub's own plan, its card titled so;
 *  - a kind with no card has one while some login of it is signed in, or
 *    on this computer while none is. */
export const plans = (sources: readonly PlanSource[], accounts: readonly string[] = []): PlanCard[] => {
  const seen: Seen[] = sources.flatMap((s) => s.usage.readings.map((r) => ({ reading: shifted(r, s.offset), where: whereOf(s), source: s })));
  const push = (m: Map<string, Seen[]>, key: string, x: Seen) => m.set(key, [...(m.get(key) ?? []), x]);
  const byAccount = seen
    .filter((x) => x.reading.account)
    .reduce((m, x) => push(m, `${x.reading.kind}:${x.reading.account}`, x), new Map<string, Seen[]>());
  const hubs = new Map<string, string>();
  const groups = seen
    .filter((x) => !x.reading.account)
    .reduce((m, x) => {
      if (!x.source.local) {
        const key = `${x.reading.kind}@${x.source.hubId}`;
        hubs.set(key, x.source.label);
        return push(m, key, x);
      }
      if (x.reading.where === "hub") return m;
      // Only onto a card with readings of its own: never a guess under an
      // account's name that has none yet.
      const ofKind = [...byAccount.keys()].filter((k) => k.startsWith(`${x.reading.kind}:`));
      return ofKind.length === 1 ? push(m, ofKind[0]!, x) : m;
    }, new Map(byAccount));
  const cards: PlanCard[] = [...groups].map(([key, xs]) => {
    const newest = [...xs].sort((a, b) => b.reading.observedAt.localeCompare(a.reading.observedAt));
    const top = newest[0]!;
    return {
      key,
      kind: top.reading.kind,
      plan: newest.find((x) => x.reading.plan)?.reading.plan ?? null,
      where: top.where,
      hub: hubs.get(key) ?? null,
      state: "reading",
      reading: top.reading,
    };
  });
  const waiting = accounts
    .filter((key) => !groups.has(key))
    .flatMap((key): PlanCard[] => {
      const kind = KINDS.find((k) => key.startsWith(`${k}:`));
      return kind ? [{ key, kind, plan: null, where: "this computer", hub: null, state: "no-reading", reading: null }] : [];
    });
  const all = [...cards, ...waiting];
  const empty = KINDS.filter((kind) => !all.some((c) => c.kind === kind)).flatMap((kind): PlanCard[] => {
    const signedIn = sources.find((s) => s.usage.logins.some((l) => l.kind === kind && l.signedIn));
    if (signedIn)
      return [{ key: `${kind}@none`, kind, plan: null, where: whereOf(signedIn), hub: null, state: "no-reading", reading: null }];
    return sources.some((s) => s.local)
      ? [{ key: `${kind}@out`, kind, plan: null, where: "this computer", hub: null, state: "signed-out", reading: null }]
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
