// The Floor of one sidebar group, as a grid's pane shows it: what needs you,
// what's working and done, the lanes of Today and the sections, each only
// for that group's items. The plans and Spend are the person's, not a
// group's, and stay whole. Everything under a pane showing one group reads
// the floor through this scope, so its counts and lists agree; the rest of
// Desk (the sidebar's badges, the Floor itself) never sees it.

import { createContext, useContext } from "react";
import { UNGROUPED, type DeskGroup, type ItemKey } from "../groups/model";
import type { Merged, Tagged } from "./merge";
import { itemKeyOf } from "./needs";
import type { Who } from "../hub/types";

/** The group the Floor here is of; null: everything. */
export const FloorScope = createContext<string | null>(null);

/** What the ids of the Floor's elements start with here: a grid can show
 *  the Floor more than once, beside the Floor view's own. */
export const FloorIds = createContext("");

export const useFloorIds = (): string => useContext(FloorIds);

export const useFloorScope = (): string | null => useContext(FloorScope);

type Placed = Pick<Tagged, "hubId" | "local" | "machine"> & { who: Pick<Who, "kind" | "id">; group?: string | null };

/** The group an item on the floor is in: this computer's hub's word for its
 *  own items where it stamped one, else the sidebar's by the item's key. */
export const groupOfFloorItem = (groups: readonly DeskGroup[], item: Placed): string | null => {
  if (item.local && !item.machine && "group" in item) return item.group ?? null;
  return groupOfKey(groups, itemKeyOf(item) as ItemKey);
};

/** The sidebar group item `key` is in; null when it's in none. */
export const groupOfKey = (groups: readonly DeskGroup[], key: ItemKey): string | null => {
  const g = groups.find((x) => x.items.includes(key))?.id ?? UNGROUPED;
  return g === UNGROUPED ? null : g;
};

/** `m` less everything outside group `group`. */
export const scoped = (m: Merged, group: string, groups: readonly DeskGroup[], day = 0): Merged => {
  const mine = <T extends Placed>(xs: readonly T[]): T[] => xs.filter((x) => groupOfFloorItem(groups, x) === group);
  const needs = mine(m.needs);
  const working = mine(m.working);
  const done = mine(m.done);
  return {
    ...m,
    needs,
    wentAhead: mine(m.wentAhead),
    working,
    done,
    lanes: mine(m.lanes),
    // Done today: the hubs' `done` reaches back a day.
    counts: { working: working.length, needsYou: needs.length, doneToday: done.filter((w) => !!w.endedAt && Date.parse(w.endedAt) >= day).length },
    more: { done: 0, lanes: 0 },
    // The hubs' paragraphs are of everything: Desk says its own of the group.
    summaries: [],
  };
};
