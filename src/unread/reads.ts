import { create } from "zustand";
import { useChat } from "../chat/store";
import { DESK_DM, type HubAccount } from "../chat/types";
import { HubError } from "../hub/client";
import { useDesk } from "../hub/store";
import type { ReadPoint, ReadRow, RoomMessage } from "../hub/types";
import { putConversationRead } from "../hubs/surface";
import { deskState } from "../restore/boot";
import { instant, justBefore } from "../rooms/time";
import { parsePlace, placeKey, type Place } from "./places";
import { hold } from "./watching";
import type { ConversationUnread } from "../hubs/surface";

// Read points: this computer's hub's (rooms, threads, sessions, Activity,
// the brief, the update) and each agent hub's DM points, as last heard. A
// write goes to the hub that owns the place, which merges it forward-only;
// while that hub is away it waits under `unread.pending.<hub>`, and is sent
// as an advance once the hub is back, where order doesn't matter.

interface ReadsState {
  /** This computer's hub's points, by place key. */
  local: Record<string, ReadPoint>;
  /** DM points on the agents' hubs, by agent key (`hub/agent`). */
  dms: Record<string, ReadPoint>;
  /** This computer's hub's points have been read. */
  loaded: boolean;
}

export const useReads = create<ReadsState>(() => ({ local: {}, dms: {}, loaded: false }));

/** Whether point `a` is after point `b` (any point is after none). */
export const laterPoint = (a: ReadPoint, b: ReadPoint | null | undefined): boolean => !b || instant(a.at) > instant(b.at);

/** The point message `m` is read through, only when it's later than `point`:
 *  a point never moves back. */
export const advanced = (point: ReadPoint | null | undefined, m: Pick<RoomMessage, "id" | "createdAt">): ReadPoint | null => {
  const next = { at: m.createdAt, message: m.id };
  return laterPoint(next, point) ? next : null;
};

/** The point that leaves `m` and what follows it unread: the message
 *  before it in its place, else a moment before it. */
export const unreadFrom = (m: Pick<RoomMessage, "createdAt">, before: Pick<RoomMessage, "id" | "createdAt"> | null): ReadPoint =>
  before ? { at: before.createdAt, message: before.id } : { at: justBefore(m.createdAt), message: null };

/** A place's point as it counts: never before Desk began keeping them. */
export const effective = (point: ReadPoint | null | undefined, floor: string | null | undefined): ReadPoint | null => {
  if (!floor) return point ?? null;
  const start = { at: floor, message: null };
  return !point || laterPoint(start, point) ? start : point;
};

const localHub = (): HubAccount | undefined => useChat.getState().hubs.find((h) => h.local);
const hubOf = (place: Place): HubAccount | undefined =>
  place.kind === "dm" ? useChat.getState().hubs.find((h) => h.id === place.hub) : localHub();

const pendingKey = (hubId: string) => `unread.pending.${hubId}`;

interface Pending {
  place: Place;
  point: ReadPoint;
  /** Absent in what was kept before Mark unread waited too: an advance. */
  mark?: "advance" | "set";
}

const pendingOf = (hubId: string): Pending[] => {
  const v = deskState.get(pendingKey(hubId));
  return Array.isArray(v) ? (v as Pending[]) : [];
};

/** A write that couldn't reach its hub, kept to send once it's back; one
 *  the hub refused, has no route for, or keeps no points for (503) isn't. */
const keep = (hubId: string, w: Pending, e: unknown) => {
  if (e instanceof HubError && ((e.status >= 400 && e.status < 500) || e.status === 503)) return;
  deskState.set(pendingKey(hubId), [...pendingOf(hubId).filter((p) => placeKey(p.place) !== placeKey(w.place)), w]);
};

/** Points the local hub says moved, in this window or another. */
export const heard = (rows: readonly ReadRow[]): void =>
  useReads.setState((s) => ({ local: { ...s.local, ...Object.fromEntries(rows.map((r) => [r.place, { at: r.at, message: r.message }])) } }));

/** Every point this computer's hub keeps, read afresh. */
export const loadLocal = (rows: readonly ReadRow[]): void =>
  useReads.setState({ local: Object.fromEntries(rows.map((r) => [r.place, { at: r.at, message: r.message }])), loaded: true });

/** Called after a DM point is written: its hub's counts are read again. */
let dmWritten: (hub: HubAccount) => void = () => {};
export const onDmWritten = (f: (hub: HubAccount) => void): void => void (dmWritten = f);

/** A point's current value, as heard. */
export const pointOf = (place: Place): ReadPoint | undefined => {
  const s = useReads.getState();
  return place.kind === "dm" ? s.dms[`${place.hub}/${place.agent}`] : s.local[placeKey(place)];
};

const shown = (place: Place, point: ReadPoint) =>
  useReads.setState((s) =>
    place.kind === "dm"
      ? { dms: { ...s.dms, [`${place.hub}/${place.agent}`]: point } }
      : { local: { ...s.local, [placeKey(place)]: point } },
  );

/** Writes `point` for `place` on its hub, as `mark`. */
async function write(place: Place, point: ReadPoint, mark: "advance" | "set"): Promise<void> {
  const hub = hubOf(place);
  if (!hub) return;
  // A hub whose link said what it offers, without DM read points, takes
  // none; one not heard from here (a detached window has no links) is asked.
  const offers = useChat.getState().hubFeatures[hub.id];
  if (place.kind === "dm" && offers && !offers.has("desk.reads")) return;
  try {
    if (place.kind === "dm") {
      await putConversationRead(hub, place.agent, { channel: DESK_DM, at: point.at, message: point.message, mark });
      dmWritten(hub);
    } else {
      const desk = useDesk.getState().hub;
      if (!desk) throw new Error("Desk isn’t connected to its hub.");
      heard(await desk.putReads([{ place: placeKey(place), point, mark }]));
    }
  } catch (e) {
    keep(hub.id, { place, point, mark }, e);
  }
}

/** `place` was read through `point`; nothing happens unless that is later
 *  than its point now. */
export const advance = (place: Place, point: ReadPoint): Promise<void> => {
  if (!laterPoint(point, pointOf(place))) return Promise.resolve();
  shown(place, point);
  return write(place, point, "advance");
};

/** `place` is unread again from just after `point`: on screen here, it
 *  stays so until it's shown again. */
export const markUnread = (place: Place, point: ReadPoint): Promise<void> => {
  hold(place);
  shown(place, point);
  return write(place, point, "set");
};

/** A room's main timeline and every thread of it read through their newest. */
export const markRoomRead = async (room: string): Promise<void> => {
  const desk = useDesk.getState().hub;
  if (desk) heard(await desk.markAllRead({ room }));
};

/** Sends what waited for `hubId` while it was away: the last write to
 *  each place, so a Mark unread made meanwhile still moves it back. */
export async function flushPending(hubId: string): Promise<void> {
  const waiting = pendingOf(hubId);
  if (!waiting.length) return;
  deskState.remove(pendingKey(hubId));
  for (const w of waiting) await write(w.place, w.point, w.mark ?? "advance");
}

/** Everything read: this computer's places in one call to its hub, and each
 *  DM with something unread through its newest message. Answers how to put
 *  each point back as it was (Undo). */
export async function markEverythingRead(dms: Readonly<Record<string, ConversationUnread>>, floor: string | null): Promise<() => Promise<void>> {
  const before = useReads.getState();
  const desk = useDesk.getState().hub;
  const moved = desk ? await desk.markAllRead("everything") : [];
  heard(moved);
  const dmMoved: [Place, ReadPoint | undefined][] = [];
  for (const [key, u] of Object.entries(dms)) {
    if (!u.count || !u.last) continue;
    const [hub = "", ...rest] = key.split("/");
    const place: Place = { kind: "dm", hub, agent: rest.join("/") };
    dmMoved.push([place, before.dms[key]]);
    await advance(place, { at: u.last.at, message: u.last.message_id });
  }
  return async () => {
    for (const r of moved) {
      const place = parsePlace(r.place);
      const was = before.local[r.place] ?? (floor ? { at: floor, message: null } : undefined);
      if (place && was) await markUnread(place, was);
    }
    for (const [place, was] of dmMoved) if (was) await markUnread(place, was);
  };
}
