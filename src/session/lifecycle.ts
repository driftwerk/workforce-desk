import { create } from "zustand";
import { close, sessionKeyIn, type Pane } from "../grids/engine";
import { changePanes, useGrids, writes } from "../grids/store";
import { engineListeners, hubOf as engineOf, useDesk } from "../hub/store";
import type { Removed } from "../hub/types";
import { keyOf, LOCAL, machineOf, splitKey, type MachineId } from "../hub/machines";

/** What Desk is asking before it changes a session's life. */
export type LifecycleAsk = { kind: "end"; sessionId: string } | { kind: "remove"; sessionId: string } | { kind: "clear" };

export const useLifecycle = create<{ asking: LifecycleAsk | null }>(() => ({ asking: null }));

/** Opens the confirm for `ask` (see `LifecycleDialogs`). */
export const askLifecycle = (ask: LifecycleAsk): void => useLifecycle.setState({ asking: ask });

export const closeLifecycle = (): void => useLifecycle.setState({ asking: null });

/** `panes` without session `key`: each pane that shows it closes, its
 *  neighbours taking its room (a parked one just goes); null when none
 *  showed it. */
export const withoutSession = (panes: Pane[], key: string): Pane[] | null => {
  let next = panes;
  for (const p of panes) if (sessionKeyIn(p.content) === key) next = close(next, p.id);
  return next === panes ? null : next;
};

/** The panes this window writes that show session `key` close: it's gone
 *  from Desk, so nothing is left to show (and no empty pane is left where
 *  it was). */
export const dropPanesOf = (key: string): void => {
  for (const gridId of useGrids.getState().order) {
    if (writes(gridId)) changePanes(gridId, (panes) => withoutSession(panes, key));
  }
};

/** The most closed sessions an engine lists (the hub's `CLOSED_LISTED`): a
 *  list that long may not be all of them. */
export const CLOSED_LISTED = 200;

/** Each machine's restore offers, by session key, as its last snapshot
 *  said them (this computer's are `useDesk`'s `restore`). */
const offeredOn = new Map<MachineId, Set<string>>();

/** By machine, the sessions its engine said were closed since its last
 *  snapshot: their panes stay, without asking again. */
const closedOn = new Map<MachineId, Set<string>>();

/** Each machine's sweep under way, so triggers together ask once. */
const sweeping = new Map<MachineId, Promise<void>>();

/** The sessions of `machine` that panes this window writes still show
 *  while its engine doesn't list them, nor offers to restore them: removed,
 *  or closed. */
const unlisted = (machine: MachineId): string[] => {
  const { sessions, restore } = useDesk.getState();
  const restoring = machine === LOCAL ? new Set(restore.map((r) => keyOf(LOCAL, r.id))) : (offeredOn.get(machine) ?? new Set<string>());
  const { order, grids } = useGrids.getState();
  const keys = new Set<string>();
  for (const gridId of order) {
    if (!writes(gridId)) continue;
    for (const p of grids[gridId]?.panes ?? []) {
      const key = sessionKeyIn(p.content);
      if (key && splitKey(key).machine === machine && !sessions[key] && !restoring.has(key)) keys.add(key);
    }
  }
  return [...keys];
};

/** Panes left showing a session that was removed while this window wasn't
 *  listening (Desk closed, a grid's window opening, its engine restarting)
 *  close too. A closed one keeps its pane, to resume: only those its engine
 *  lists neither as running, to restore nor as closed go. Asked while
 *  another sweep of `machine` waits on its engine, it is that one. */
export function sweepRemoved(machine: MachineId): Promise<void> {
  const under = sweeping.get(machine);
  if (under) return under;
  if (!useGrids.getState().ready || !useDesk.getState().engines[machine]?.loaded) return Promise.resolve();
  const hub = engineOf(machine);
  const known = closedOn.get(machine);
  if (!hub || unlisted(machine).every((k) => known?.has(k))) return Promise.resolve();
  const run = hub
    .closedSessions()
    .then(
      (list) => {
        // A full list may leave older closed sessions out: none is taken
        // for removed on its word.
        if (list.length >= CLOSED_LISTED) return;
        const closed = new Set(list.map((s) => keyOf(machine, s.id)));
        closedOn.set(machine, closed);
        // As things are now: one listed again meanwhile stays.
        for (const key of unlisted(machine)) if (!closed.has(key)) dropPanesOf(key);
      },
      () => undefined, // Not said: nothing is taken for gone.
    )
    .finally(() => sweeping.delete(machine));
  sweeping.set(machine, run);
  return run;
}

const sweepAll = (): void => {
  for (const machine of Object.keys(useDesk.getState().engines)) void sweepRemoved(machine);
};

// Gone from its engine (removed here or in another window, by its boss, or
// cleared in bulk): the panes this window writes stop showing it. Once an
// engine has said what it has, panes left from a removal this window
// didn't hear of go too.
engineListeners.add((e) => {
  const machine = machineOf(e);
  if (e.type === "removed") {
    closedOn.get(machine)?.delete(keyOf(machine, e.id));
    dropPanesOf(keyOf(machine, e.id));
  }
  if (e.type === "snapshot") {
    if (machine !== LOCAL) offeredOn.set(machine, new Set(e.restore.map((r) => keyOf(machine, r.id))));
    closedOn.delete(machine);
    void sweepRemoved(machine);
  }
});

// And once this window has its grids, or takes over writing one (a grid's
// own window closed).
useGrids.subscribe((s, before) => {
  if ((s.ready && !before.ready) || (s.open !== before.open && Object.keys(before.open).some((id) => !s.open[id]))) sweepAll();
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
  dropPanesOf(key);
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
