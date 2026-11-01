import { create } from "zustand";
import { findContent } from "../grids/engine";
import { changePanes, useGrids, writes } from "../grids/store";
import { useDesk } from "../hub/store";
import type { Removed } from "../hub/types";

/** What Desk is asking before it changes a session's life. */
export type LifecycleAsk = { kind: "end"; sessionId: string } | { kind: "remove"; sessionId: string } | { kind: "clear" };

export const useLifecycle = create<{ asking: LifecycleAsk | null }>(() => ({ asking: null }));

/** Opens the confirm for `ask` (see `LifecycleDialogs`). */
export const askLifecycle = (ask: LifecycleAsk): void => useLifecycle.setState({ asking: ask });

export const closeLifecycle = (): void => useLifecycle.setState({ asking: null });

/** The panes this window writes that show session `id`, emptied: it's gone
 *  from Desk, so they don't keep saying so. */
const emptyPanesOf = (id: string): void => {
  const { order } = useGrids.getState();
  for (const gridId of order) {
    if (!writes(gridId)) continue;
    changePanes(gridId, (panes) => {
      const shown = findContent(panes, { kind: "session", sessionId: id });
      return shown ? panes.map((p) => (p.id === shown.id ? { ...p, content: null } : p)) : null;
    });
  }
};

const hubOf = () => {
  const { hub } = useDesk.getState();
  if (!hub) throw new Error("Desk isn't connected to its hub.");
  return hub;
};

/** Removes session `id` from Desk, and its engine's transcript when asked;
 *  out of the sidebar, the Floor, Unread and every pane here at once (the
 *  hub says so too). */
export async function removeSession(id: string, transcript: boolean): Promise<Removed> {
  const done = await hubOf().remove(id, transcript);
  useDesk.setState((s) => {
    const { [id]: _gone, ...rest } = s.sessions;
    return { sessions: rest, openId: s.openId === id ? null : s.openId };
  });
  emptyPanesOf(id);
  return done;
}

/** Ends session `id`: stopped if it runs here, and closed. */
export async function endSessionNow(id: string): Promise<void> {
  await hubOf().end(id);
}

/** Removes every session finished more than `days` ago, or only counts
 *  them. */
export async function clearFinished(days: number, dryRun: boolean, transcripts = false): Promise<number> {
  const done = await hubOf().clearFinished({ olderThanDays: days, dryRun, transcripts });
  return done.removed;
}
