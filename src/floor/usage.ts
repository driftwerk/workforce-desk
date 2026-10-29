import type { PlanKind, PlanReading, PlanWindow, UsageView } from "../hub/types";
import { shift } from "./merge";

/** One hub's usage, as read. */
export interface PlanSource {
  hubId: string;
  label: string;
  local: boolean;
  usage: UsageView;
  /** The hub's clock less this Mac's. */
  offset: number;
}

/** One plan account's card: its freshest reading wherever it came from; a
 *  login with none yet; or, on this Mac, no sign-in at all. */
export interface PlanCard {
  key: string;
  kind: PlanKind;
  plan: string | null;
  /** Where its reading came from: "this Mac", or a remote hub's name. */
  where: string;
  state: "reading" | "no-reading" | "signed-out";
  /** In this Mac's time. */
  reading: PlanReading | null;
}

export const KINDS: readonly PlanKind[] = ["claude", "chatgpt"];

const whereOf = (s: PlanSource): string => (s.local ? "this Mac" : s.label);

const shifted = (r: PlanReading, offset: number): PlanReading => ({
  ...r,
  observedAt: shift(r.observedAt, offset),
  windows: r.windows.map((w) => ({ ...w, resetsAt: w.resetsAt === null ? null : shift(w.resetsAt, offset) })),
});

interface Seen {
  reading: PlanReading;
  where: string;
  from: string;
}

/** The cards for every hub's readings: one per account (readings of one
 *  account through several logins are one card, the freshest shown); a
 *  reading that names no account joins the only card of its kind, else has
 *  its own; a kind with no reading has a card while some login of it is
 *  signed in, or on this Mac while none is. */
export const plans = (sources: readonly PlanSource[]): PlanCard[] => {
  const seen: Seen[] = sources.flatMap((s) =>
    s.usage.readings.map((r) => ({ reading: shifted(r, s.offset), where: whereOf(s), from: `${s.hubId}:${r.where}` })),
  );
  const push = (m: Map<string, Seen[]>, key: string, x: Seen) => m.set(key, [...(m.get(key) ?? []), x]);
  const accounts = seen.filter((x) => x.reading.account).reduce((m, x) => push(m, `${x.reading.kind}:${x.reading.account}`, x), new Map<string, Seen[]>());
  const groups = seen
    .filter((x) => !x.reading.account)
    .reduce((m, x) => {
      const ofKind = [...accounts.keys()].filter((k) => k.startsWith(`${x.reading.kind}:`));
      return push(m, ofKind.length === 1 ? ofKind[0]! : `${x.reading.kind}@${x.from}`, x);
    }, new Map(accounts));
  const cards: PlanCard[] = [...groups].map(([key, xs]) => {
    const newest = [...xs].sort((a, b) => b.reading.observedAt.localeCompare(a.reading.observedAt));
    const top = newest[0]!;
    return {
      key,
      kind: top.reading.kind,
      plan: newest.find((x) => x.reading.plan)?.reading.plan ?? null,
      where: top.where,
      state: "reading",
      reading: top.reading,
    };
  });
  const empty = KINDS.filter((kind) => !cards.some((c) => c.kind === kind)).flatMap((kind): PlanCard[] => {
    const signedIn = sources.find((s) => s.usage.logins.some((l) => l.kind === kind && l.signedIn));
    if (signedIn) return [{ key: `${kind}@none`, kind, plan: null, where: whereOf(signedIn), state: "no-reading", reading: null }];
    return sources.some((s) => s.local) ? [{ key: `${kind}@out`, kind, plan: null, where: "this Mac", state: "signed-out", reading: null }] : [];
  });
  return [...cards, ...empty].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
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
 *  for nothing, never for the percentage it had then. */
export const windowNow = (w: PlanWindow, observedAt: string, now: number): { used: number; resetAt: number | null; reset: boolean } => {
  const resetAt = resetMs(w);
  const start = startMs(w);
  const reset = resetAt !== null && (resetAt <= now || (start !== null && Date.parse(observedAt) < start));
  return { used: reset ? 0 : w.usedPercent, resetAt, reset };
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
