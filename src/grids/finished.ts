import { deskListeners, useDesk } from "../hub/store";
import { keyOf } from "../hub/machines";
import type { ActivityEvent, DeskEvent } from "../hub/types";
import { sessionKeyIn } from "./engine";
import { closePane, useGrids, writes } from "./store";

// A session its boss closed as finished leaves the grid: its pane goes, so
// the grid holds what is still going on. Its conversation stays, to resume
// from the sidebar's history or the boss's Undo. A session you end yourself
// keeps its pane, saying it's closed, with Resume.

/** Whether `e` is a boss closing a session of this computer's: a manager
 *  stopping it, and the session closed now, not just stopped. */
export const bossClosed = (e: ActivityEvent, open: (key: string) => boolean): string | null => {
  if (e.kind !== "stopped" || e.actor.kind !== "manager" || e.subject?.kind !== "session") return null;
  const key = keyOf(null, e.subject.id);
  return open(key) ? null : key;
};

/** Takes session `key` out of every grid this window writes. */
export const clearFromGrids = (key: string): void => {
  const { grids } = useGrids.getState();
  for (const g of Object.values(grids)) {
    if (!writes(g.id)) continue;
    for (const p of g.panes) if (sessionKeyIn(p.content) === key) closePane(g.id, p.id);
  }
};

export const onFinishedEvent = (e: DeskEvent): void => {
  if (e.type !== "activity") return;
  const key = bossClosed(e.event, (k) => {
    const s = useDesk.getState().sessions[k];
    return !!s && s.state !== "closed";
  });
  if (key) clearFromGrids(key);
};

deskListeners.add(onFinishedEvent);
