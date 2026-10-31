// The order the sidebar lists rooms in, as the person dragged them: kept
// under `rooms.order` in Desk's restore store (in Desk's own file at once,
// on the hub shortly after), so it's the same after a restart and on
// another computer. Rooms it doesn't name yet — new ones — come after, oldest
// first; rooms the hub no longer has drop out of it.

import { create } from "zustand";
import { useDesk } from "../hub/store";
import type { Room } from "../hub/types";
import type { Restorable } from "../restore/boot";
import { moved, nudged } from "../ui/reorder";
import { forgetRoomLevel } from "../unread/prefs";

export const ROOMS_PREFIX = "rooms.";
export const ROOM_ORDER_KEY = "rooms.order";

export const useRoomOrder = create<{ order: string[] }>(() => ({ order: [] }));

const readOrder = (v: unknown): string[] => {
  const order = (v as { order?: unknown } | null)?.order;
  return Array.isArray(order) ? order.filter((x): x is string => typeof x === "string") : [];
};

const oldestFirst = (a: Room, b: Room) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.name.localeCompare(b.name);

/** The rooms in the person's order: those it names, then the rest, oldest
 *  first. */
export const arranged = (rooms: Record<string, Room>, order: readonly string[]): Room[] => {
  const named = new Set(order);
  const first = order.flatMap((id) => rooms[id] ?? []);
  const rest = Object.values(rooms).filter((r) => !named.has(r.id));
  // Until you first arrange them, rooms stay by name, as they always were;
  // after that, a room the order doesn't name yet goes last.
  if (!order.length) return rest.sort((a, b) => a.name.localeCompare(b.name));
  return [...first, ...rest.sort(oldestFirst)];
};

const shown = () => arranged(useDesk.getState().rooms, useRoomOrder.getState().order).map((r) => r.id);

/** Moves room `id` before room `before` (last when null). */
export const moveRoom = (id: string, before: string | null): void => {
  const next = moved(shown(), id, before);
  if (next) useRoomOrder.setState({ order: next });
};

/** Moves room `id` one place up or down; false when it's already at that end. */
export const nudgeRoom = (id: string, by: -1 | 1): boolean => {
  const next = nudged(shown(), id, by);
  if (next) useRoomOrder.setState({ order: next });
  return !!next;
};

/** Room `id` is gone: out of the order. */
export const forgetRoom = (id: string): void => {
  useRoomOrder.setState((s) => (s.order.includes(id) ? { order: s.order.filter((x) => x !== id) } : s));
  forgetRoomLevel(id);
};

/** Rooms deleted elsewhere (the hub says so) drop out of the order. Only
 *  once the hub has said which rooms it has: until then there are none,
 *  which isn't the same as their having gone. */
export const followRooms = (): (() => void) =>
  useDesk.subscribe((s, before) => {
    if (!s.loaded || !before.loaded || s.rooms === before.rooms) return;
    for (const id of Object.keys(before.rooms)) if (!s.rooms[id]) forgetRoom(id);
  });

export const roomOrder: Restorable = {
  key: ROOM_ORDER_KEY,
  read: () => ({ order: useRoomOrder.getState().order }),
  write: (v) => useRoomOrder.setState({ order: readOrder(v) }),
  subscribe: (onChange) => useRoomOrder.subscribe(onChange),
};
