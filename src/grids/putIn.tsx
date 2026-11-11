// Putting a room, a board or a group's Floor into a grid from its sidebar
// row: "Put in a grid ›", with each grid (and where it would go there) and
// a new one; and the row's mark while it's in one.

import { useId, type ReactNode } from "react";
import type { MenuEntry } from "../ui/Menu";
import { findContent, laidOut, type PaneContent } from "./engine";
import { InGrid, inGridSays, useGridNames } from "./InGrid";
import { useGrids } from "./store";
import { addToGrid, reveal } from "./windows";
import { useDesk } from "../hub/store";

/** A room's or a board's row, clicked: in the Grids view, where a grid
 *  shows it, it's shown there (as a session's row does); else `open`, as
 *  always. */
export const openFromRow = (content: PaneContent, open: () => void): void => {
  if (useDesk.getState().view === "grids" && reveal(content)) return;
  open();
};

/** Where `content` would go in a grid with `panes`: its first empty pane, a
 *  pane of its own beside the largest, or where it already is. */
export const whereInGrid = (panes: Parameters<typeof laidOut>[0], content: PaneContent): "the empty pane" | "adds a pane" | "already in it" =>
  findContent(panes, content) ? "already in it" : laidOut(panes).some((p) => !p.content) ? "the empty pane" : "adds a pane";

/** "Put in a grid ›": each grid, saying where it would go there (already
 *  there, it's shown), then "A new grid". Chosen, it's put there and shown. */
export const putInGrid = (content: PaneContent, hint?: string): MenuEntry => {
  const { order, grids } = useGrids.getState();
  const listed = order.flatMap((id) => (grids[id] ? [grids[id]!] : []));
  return {
    kind: "item",
    label: "Put in a grid",
    ...(hint ? { hint } : {}),
    submenu: [
      ...listed.map((g): MenuEntry => ({ kind: "item", label: g.name, hint: whereInGrid(g.panes, content), onSelect: () => void addToGrid(content, g.id) })),
      ...(listed.length ? [{ kind: "separator" as const }] : []),
      { kind: "item", label: "A new grid", onSelect: () => void addToGrid(content, null) },
    ],
  };
};

/** A row's "in a grid" mark (see `InGrid`): the element its row names in
 *  aria-describedby, and the mark; none while it's in no grid. */
export function useInGridMark(item: string): { id: string | null; mark: ReactNode } {
  const names = useGridNames(item);
  const id = `${useId()}-grid`;
  if (!names.length) return { id: null, mark: null };
  return { id, mark: <InGrid id={id} says={inGridSays(names)} /> };
}

/** A sidebar row drawn with its "in a grid" mark: `row` gets the mark and
 *  the id the row's aria-describedby names (null while in no grid). */
export function InGridRow({ item, row }: { item: string; row: (mark: ReactNode, markId: string | null) => ReactNode }) {
  const { id, mark } = useInGridMark(item);
  return <>{row(mark, id)}</>;
}
