import type { Need, Span, Who, Work } from "../hub/types";
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

const endOf = (s: Span): number => (s.to === null ? Number.POSITIVE_INFINITY : Date.parse(s.to));

/** `spans` in order, those of a kind that overlap or touch made one. */
const joined = (spans: readonly Span[]): Span[] => {
  const out: Span[] = [];
  const last = new Map<Span["kind"], number>();
  for (const s of [...spans].sort((a, b) => Date.parse(a.from) - Date.parse(b.from))) {
    const i = last.get(s.kind);
    const had = i === undefined ? undefined : out[i];
    if (i === undefined || !had || endOf(had) < Date.parse(s.from)) {
      last.set(s.kind, out.push(s) - 1);
    } else if (endOf(s) > endOf(had)) {
      out[i] = { ...had, to: s.to };
    }
  }
  return out;
};

/** `lanes` as `whoOf` has whose each is: one that turns out to be an
 *  agent's (a session its turn ran as) goes in that agent's lane, which
 *  keeps its own name. */
export const asWho = (lanes: readonly FloorLane[], whoOf: (lane: FloorLane) => Who): FloorLane[] => {
  const by = new Map<string, { lane: FloorLane; own: boolean }>();
  for (const l of lanes) {
    const who = whoOf(l);
    const own = who.kind === l.who.kind && who.id === l.who.id;
    const key = own ? l.key : `${l.hubId}/${who.kind}:${who.id}`;
    const had = by.get(key);
    by.set(
      key,
      had
        ? { lane: { ...had.lane, who: had.own || !own ? had.lane.who : who, spans: joined([...had.lane.spans, ...l.spans]) }, own: had.own || own }
        : { lane: { ...l, who, key }, own },
    );
  }
  return [...by.values()].map((x) => x.lane);
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
