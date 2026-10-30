import type { HubAccount } from "../chat/types";
import type { Counts, Lane, Need, Span, Work } from "../hub/types";
import type { HubFloor } from "./store";

/** Which hub an item came from (and whether it's this computer's), its key
 *  across hubs, and whether that hub could be reached the last time it was
 *  read. */
export interface Tagged {
  hubId: string;
  local: boolean;
  key: string;
  stale: boolean;
}

export type FloorNeed = Need & Tagged;
export type FloorWork = Work & Tagged;
export type FloorLane = Lane & Tagged;

export interface Merged {
  /** Oldest first. */
  needs: FloorNeed[];
  /** Latest started first. */
  working: FloorWork[];
  /** Latest ended first. */
  done: FloorWork[];
  lanes: FloorLane[];
  /** The hubs' own, but for what needs you: how many `needs` there are. */
  counts: Counts;
  more: { done: number; lanes: number };
}

/** A hub's time in this computer's, as `toISOString` writes it (so times from
 *  every hub compare as text): `offset` is the hub's clock less this computer's. */
export const shift = (iso: string, offset: number): string => new Date(Date.parse(iso) - offset).toISOString();
const shiftOrNull = (iso: string | null, offset: number): string | null => (iso === null ? null : shift(iso, offset));

const work = (w: Work, offset: number): Work => ({
  ...w,
  since: shift(w.since, offset),
  heardAt: shift(w.heardAt, offset),
  endedAt: shiftOrNull(w.endedAt, offset),
  background: w.background ? { ...w.background, since: shift(w.background.since, offset) } : null,
});

const span = (s: Span, offset: number): Span => ({ ...s, from: shift(s.from, offset), to: shiftOrNull(s.to, offset) });

const whoKey = (hubId: string, w: Work | Lane): string => `${hubId}/${w.who.kind}:${w.who.id}`;

const ZERO: Merged = { needs: [], working: [], done: [], lanes: [], counts: { working: 0, needsYou: 0, doneToday: 0 }, more: { done: 0, lanes: 0 } };

/** Every hub's floor as one, in this computer's time; hubs that have none (yet,
 *  or at all) add nothing, and one that couldn't be reached last time adds
 *  what it said before. */
export const merged = (hubs: Readonly<Record<string, HubFloor>>, hubList: readonly HubAccount[]): Merged => {
  const all = hubList.reduce<Merged>((m, hub) => {
    const f = hubs[hub.id];
    const view = f?.state === "ready" ? f.floor : null;
    if (!f || !view) return m;
    const tag = { hubId: hub.id, local: hub.local, stale: f.stale };
    return {
      needs: [...m.needs, ...view.needs.map((n) => ({ ...n, since: shift(n.since, f.offset), ...tag, key: `${hub.id}/${n.id}` }))],
      working: [...m.working, ...view.working.map((w) => ({ ...work(w, f.offset), ...tag, key: `${whoKey(hub.id, w)}@${w.since}` }))],
      done: [...m.done, ...view.done.map((w) => ({ ...work(w, f.offset), ...tag, key: `${whoKey(hub.id, w)}@${w.since}` }))],
      lanes: [...m.lanes, ...view.lanes.map((l) => ({ ...l, spans: l.spans.map((s) => span(s, f.offset)), ...tag, key: whoKey(hub.id, l) }))],
      counts: { ...m.counts, working: m.counts.working + view.counts.working, doneToday: m.counts.doneToday + view.counts.doneToday },
      more: { done: m.more.done + view.more.done, lanes: m.more.lanes + view.more.lanes },
    };
  }, ZERO);
  return {
    ...all,
    counts: { ...all.counts, needsYou: all.needs.length },
    needs: all.needs.sort((a, b) => a.since.localeCompare(b.since)),
    working: all.working.sort((a, b) => b.since.localeCompare(a.since)),
    done: all.done.sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? "")),
  };
};
