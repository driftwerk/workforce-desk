import type { FloorNeed } from "../floor/merge";
import type { RoomDraft } from "../hub/store";
import type { Room, RoomMessage, RoomSummary } from "../hub/types";
import { instant } from "./time";
import { placeKey } from "./window";

// Every place in your rooms with something in flight: one row per thread,
// and one per room for its main timeline, in the worst state present.

export type FlightState = "needs" | "failed" | "working" | "queued" | "unread";

export interface FlightRow {
  key: string;
  room: Room;
  thread: string | null;
  /** The thread's first message, or the ask in the main timeline. */
  parent: RoomMessage | null;
  /** Who is in flight there. */
  members: string[];
  state: FlightState;
  /** When its oldest answer on its way was asked (ms). */
  since: number | null;
  lastAt: string | null;
  needs: FloorNeed[];
}

const RANK: Record<FlightState, number> = { needs: 0, failed: 1, working: 2, queued: 3, unread: 4 };

const stateOf = (d: RoomDraft): FlightState =>
  d.prompts.length
    ? "needs"
    : d.state === "failed" || d.state === "stopped" || d.state === "interrupted"
      ? "failed"
      : d.state === "queued" || d.state === "busy"
        ? "queued"
        : "working";

/** Every place with something in flight, needs first, then newest. */
export const flightRows = (
  rooms: Readonly<Record<string, Room>>,
  summaries: readonly RoomSummary[],
  drafts: Readonly<Record<string, readonly RoomDraft[]>>,
  needs: readonly FloorNeed[],
  timelines: Readonly<Record<string, readonly RoomMessage[]>>,
): FlightRow[] => {
  const rows = new Map<string, FlightRow>();
  const rowOf = (room: Room, thread: string | null): FlightRow => {
    const key = placeKey(room.id, thread);
    let row = rows.get(key);
    if (!row) {
      const parent = thread ? (timelines[room.id]?.find((m) => m.id === thread) ?? null) : null;
      row = { key, room, thread, parent, members: [], state: "unread", since: null, lastAt: null, needs: [] };
      rows.set(key, row);
    }
    return row;
  };
  const worse = (row: FlightRow, s: FlightState) => {
    if (RANK[s] < RANK[row.state]) row.state = s;
  };
  for (const [roomId, ds] of Object.entries(drafts)) {
    const room = rooms[roomId];
    if (!room) continue;
    for (const d of ds) {
      const row = rowOf(room, d.threadId);
      worse(row, stateOf(d));
      if (!row.members.includes(d.member)) row.members.push(d.member);
      row.since = row.since === null ? d.since : Math.min(row.since, d.since);
      if (!d.threadId && !row.parent) row.parent = timelines[roomId]?.find((m) => m.id === d.asked) ?? null;
    }
  }
  for (const n of needs) {
    if (n.place.kind !== "room" || !rooms[n.place.room]) continue;
    const row = rowOf(rooms[n.place.room]!, n.place.thread);
    row.needs.push(n);
    worse(row, "needs");
  }
  for (const s of summaries) {
    const room = rooms[s.roomId];
    if (!room) continue;
    if (s.main.count) {
      const row = rowOf(room, null);
      row.lastAt = s.main.lastAt;
      row.parent ??= timelines[room.id]?.find((m) => m.id === s.main.first) ?? null;
    }
    for (const t of s.threads)
      if (t.unread.count) {
        const row = rowOf(room, t.parent.id);
        row.parent ??= t.parent;
        row.lastAt = t.unread.lastAt;
      }
  }
  const t = (r: FlightRow) => (r.lastAt ? instant(r.lastAt) : r.since !== null ? BigInt(r.since) * 1000n : 0n);
  return [...rows.values()].sort((a, b) => RANK[a.state] - RANK[b.state] || (t(a) > t(b) ? -1 : t(a) < t(b) ? 1 : 0));
};
