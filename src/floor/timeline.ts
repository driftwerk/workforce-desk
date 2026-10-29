import type { Need, Work } from "../hub/types";
import type { FloorLane, Tagged } from "./merge";

/** Lanes shown before "Show N more". */
export const LANE_CAP = 8;

const HOUR = 3_600_000;

export interface Axis {
  from: number;
  to: number;
  /** Every other local clock hour between them. */
  ticks: number[];
}

/** The local clock hour `t` is in. Subtracted rather than set, so the hour
 *  a clock change repeats is never taken for the other one. */
const floorHour = (t: number): number => {
  const d = new Date(t);
  return t - (d.getMinutes() * 60_000 + d.getSeconds() * 1000 + d.getMilliseconds());
};

/** Today's scale, in real milliseconds (a DST day is 23 or 25 hours): from
 *  the hour the first span began (or an hour ago), never before midnight, to
 *  now; a tick on each even local hour. */
export const axis = (lanes: readonly FloorLane[], day: number, now: number): Axis => {
  const starts = lanes.flatMap((l) => l.spans.map((s) => Date.parse(s.from)));
  const first = starts.length ? floorHour(Math.min(...starts)) : now - HOUR;
  const from = Math.min(Math.max(first, day), now - 60_000);
  const next = (t: number) => floorHour(t + HOUR + HOUR / 2);
  const ticks: number[] = [];
  for (let t = floorHour(from) < from ? next(floorHour(from)) : from; t <= now; t = next(t)) {
    if (new Date(t).getHours() % 2 === 0) ticks.push(t);
  }
  return { from, to: now, ticks };
};

const MIN_WIDTH = 0.6;

/** Where a span sits on the axis, in percent; never too thin to see. */
export const box = (span: { from: string; to: string | null }, a: Axis): { left: number; width: number } => {
  const length = a.to - a.from;
  const from = Math.max(a.from, Math.min(a.to, Date.parse(span.from)));
  const to = Math.max(from, Math.min(a.to, span.to === null ? a.to : Date.parse(span.to)));
  const width = Math.max(MIN_WIDTH, ((to - from) / length) * 100);
  return { left: Math.min(((from - a.from) / length) * 100, 100 - width), width };
};

type Whom = Tagged & Pick<Need | Work, "who">;

const sameWho = (lane: FloorLane) => (x: Whom) => x.hubId === lane.hubId && x.who.kind === lane.who.kind && x.who.id === lane.who.id;

const lastEnd = (lane: FloorLane): number =>
  Math.max(...lane.spans.map((s) => (s.to === null ? Number.POSITIVE_INFINITY : Date.parse(s.to))), Number.NEGATIVE_INFINITY);

/** Waiting on the person now first, then working now, then the latest. */
export const ordered = (lanes: readonly FloorLane[], needs: readonly Whom[], working: readonly Whom[]): FloorLane[] => {
  const rank = (l: FloorLane) =>
    needs.some(sameWho(l)) || l.spans.some((s) => s.kind === "waiting" && s.to === null) ? 0 : working.some(sameWho(l)) ? 1 : 2;
  return [...lanes].sort((a, b) => rank(a) - rank(b) || lastEnd(b) - lastEnd(a));
};
