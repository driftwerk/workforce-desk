import { create } from "zustand";
import { findContent } from "../grids/engine";
import { changePanes, useGrids, writes } from "../grids/store";
import { engineListeners, hubOf as engineOf, useDesk } from "../hub/store";
import type { Removed } from "../hub/types";
import { sessionContent } from "../grids/engine";
import { keyOf, LOCAL, machineOf, splitKey, type MachineId } from "../hub/machines";

/** What Desk is asking before it changes a session's life. */
export type LifecycleAsk = { kind: "end"; sessionId: string } | { kind: "remove"; sessionId: string } | { kind: "clear" };

export const useLifecycle = create<{ asking: LifecycleAsk | null }>(() => ({ asking: null }));

/** Opens the confirm for `ask` (see `LifecycleDialogs`). */
export const askLifecycle = (ask: LifecycleAsk): void => useLifecycle.setState({ asking: ask });

export const closeLifecycle = (): void => useLifecycle.setState({ asking: null });

/** The panes this window writes that show session `key`, emptied: it's
 *  gone from Desk, so they don't keep saying so. */
const emptyPanesOf = (key: string): void => {
  const { order } = useGrids.getState();
  for (const gridId of order) {
    if (!writes(gridId)) continue;
    changePanes(gridId, (panes) => {
      const shown = findContent(panes, sessionContent(key));
      return shown ? panes.map((p) => (p.id === shown.id ? { ...p, content: null } : p)) : null;
    });
  }
};

// Gone from its engine (removed here or in another window, or cleared in
// bulk): the panes this window writes stop showing it.
engineListeners.add((e) => {
  if (e.type === "removed") emptyPanesOf(keyOf(machineOf(e), e.id));
});

/** The engine `machine` (this computer's when none), or why not. */
const hubOf = (machine: MachineId = LOCAL) => {
  const hub = engineOf(machine);
  if (!hub) throw new Error("Desk isn't connected to its hub.");
  return hub;
};

/** Removes session `key` (see `keyOf`) from Desk, and its engine's
 *  transcript when asked; out of the sidebar, the Floor, Unread and every
 *  pane here at once (its engine says so too). */
export async function removeSession(key: string, transcript: boolean): Promise<Removed> {
  const { machine, id } = splitKey(key);
  const done = await hubOf(machine).remove(id, transcript);
  useDesk.setState((s) => {
    const { [key]: _gone, ...rest } = s.sessions;
    return { sessions: rest, openId: s.openId === key ? null : s.openId };
  });
  emptyPanesOf(key);
  return done;
}

/** Ends session `key`: stopped if it runs here, and closed. */
export async function endSessionNow(key: string): Promise<void> {
  const { machine, id } = splitKey(key);
  await hubOf(machine).end(id);
}

/** Removes every session finished more than `days` ago, or only counts
 *  them. */
export async function clearFinished(days: number, dryRun: boolean, transcripts = false): Promise<number> {
  const done = await hubOf().clearFinished({ olderThanDays: days, dryRun, transcripts });
  return done.removed;
}
