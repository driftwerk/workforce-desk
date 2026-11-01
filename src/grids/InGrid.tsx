import { useDesk } from "../hub/store";
import type { ItemKey } from "../groups/model";
import { useGrids, type GridsState } from "./store";
import { placesOf } from "./where";

/** The names of the grids showing `item` (see `placesOf`: windows of their
 *  own and parked panes count), each once, in the sidebar's order. Joined by
 *  a character no name holds, so a row can subscribe to a plain string. */
const SEP = "\u0000";
const namesJoined = (s: GridsState, item: ItemKey): string => {
  const ids = [...new Set(placesOf(s, useDesk.getState().sessions, item).map((p) => p.gridId))];
  return ids.map((id) => s.grids[id]?.name ?? "a grid").join(SEP);
};

/** The grids `item` is in, by name. A row re-renders only when this changes:
 *  the selectors return strings, which zustand compares by value, so a
 *  change elsewhere in the grids (or in a session that isn't this one's
 *  terminal) leaves the row alone. */
export function useGridNames(item: ItemKey): string[] {
  useGrids((s) => namesJoined(s, item));
  // A session's terminal may be tracked (or not) without a grid changing.
  useDesk((d) => (d.sessions ? namesJoined(useGrids.getState(), item) : ""));
  const joined = namesJoined(useGrids.getState(), item);
  return joined ? joined.split(SEP) : [];
}

/** "In grid Main", "In grids Main and Review", "In grids A, B and C". */
export const inGridSays = (names: readonly string[]): string =>
  names.length === 1 ? `In grid ${names[0]}` : `In grids ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** A small, quiet grid glyph for a sidebar row: the item is in a grid. The
 *  glyph carries the tooltip and is hidden from screen readers; the words
 *  are the row's description (`id`, which the row names in
 *  aria-describedby), so it isn't a stop of its own. */
export function InGrid({ id, says }: { id: string; says: string }) {
  return (
    <>
      <span className="gi-grid" title={says} aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="0.6" y="0.6" width="3.4" height="3.4" rx="0.8" />
          <rect x="6" y="0.6" width="3.4" height="3.4" rx="0.8" />
          <rect x="0.6" y="6" width="3.4" height="3.4" rx="0.8" />
          <rect x="6" y="6" width="3.4" height="3.4" rx="0.8" />
        </svg>
      </span>
      <span id={id} hidden>
        {says}
      </span>
    </>
  );
}
