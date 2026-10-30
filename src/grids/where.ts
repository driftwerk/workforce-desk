// Where a sidebar item is shown in the grids: the one answer for everything
// that asks. Showing an item from anywhere goes to it (`reveal`), a session's
// card says where it already is, and the sidebar lights the row whose pane
// has focus and points out its panes while the row is hovered.

import { sessionItem, type ItemKey } from "../groups/model";
import type { Session } from "../hub/types";
import type { PaneContent } from "./engine";
import type { GridsState } from "./store";
import { trackedIn } from "./terminals";

/** A pane showing an item. */
export interface Place {
  gridId: string;
  paneId: string;
  /** What the pane holds: the item itself, or the Desk terminal a session
   *  runs in. */
  content: PaneContent;
  /** Out of the layout for now (in the grid's Parked tray). */
  parked: boolean;
}

/** The sidebar item content is: a session (in a pane of its own, or the
 *  one running in a terminal), or an agent. */
export const itemOf = (sessions: Record<string, Session>, content: PaneContent | null): ItemKey | null => {
  if (!content) return null;
  if (content.kind === "session") return sessionItem(content.sessionId);
  if (content.kind === "agent") return `agent:${content.agent}`;
  const tracked = trackedIn(sessions, content.terminalId);
  return tracked ? sessionItem(tracked.id) : null;
};

/** Every pane showing `item`, grid by grid in the sidebar's order, in each
 *  grid as its panes are kept. Grids in a window of their own count, as
 *  this window keeps them too. */
export const placesOf = (s: Pick<GridsState, "order" | "grids">, sessions: Record<string, Session>, item: ItemKey): Place[] =>
  s.order.flatMap((gridId) =>
    (s.grids[gridId]?.panes ?? []).flatMap((p): Place[] =>
      p.content && itemOf(sessions, p.content) === item ? [{ gridId, paneId: p.id, content: p.content, parked: !p.rect }] : [],
    ),
  );

/** Where `item` can be seen: laid out in a grid of the main window, or of a
 *  window of its own that's open; a pane of its own before the terminal a
 *  session runs in, and the grid the main window shows first. */
export const shownAt = (s: GridsState, sessions: Record<string, Session>, item: ItemKey): Place | null => {
  const seen = (id: string) => s.grids[id]?.placement.kind === "main" || !!s.open[id];
  const rank = (p: Place) => (p.content.kind === "terminal" ? 2 : 0) + (p.gridId === s.active ? 0 : 1);
  const places = placesOf(s, sessions, item).filter((p) => !p.parked && seen(p.gridId));
  return places.sort((a, b) => rank(a) - rank(b))[0] ?? null;
};
