// The machines' engines, kept connected in this window: each machine the
// native side lists, while it can be driven (see `drivable`), has its own
// `DeskHub` in `useDesk.engines`, over its own transport. The main window
// and each detached grid's window keep their own.

import { create } from "zustand";
import { machinesList, onMachinesChanged, subscribe } from "../platform";
import { machineTransport } from "./broker";
import { drivable, readMachine, type Machine, type MachineId } from "./machines";
import { useDesk } from "./store";
import type { DeskTransport } from "./transport";

/** The machines as the native side last listed them. */
export const useMachines = create<{ machines: Machine[]; listed: boolean }>(() => ({ machines: [], listed: false }));

/** What the machines' engines are reached through, and listed by: the
 *  native side in the app; a test's own. */
export interface MachineSide {
  list(): Promise<unknown[]>;
  /** Calls `f` on any change; the returned function stops it. */
  changed(f: () => void): () => void;
  transport(machine: MachineId): DeskTransport;
}

export const nativeMachines: MachineSide = {
  list: machinesList,
  changed: (f) => subscribe(onMachinesChanged(f)),
  transport: machineTransport,
};

/** A machine's name, by id; its id while it isn't listed. */
export const machineName = (id: MachineId): string => useMachines.getState().machines.find((m) => m.id === id)?.name ?? id;

/** Keeps every drivable machine's engine connected in this window, as the
 *  native side lists them, again on each `machines-changed`. A machine gone
 *  from the list, or no longer drivable, is let go with its sessions.
 *  `changed` is called when an engine is opened, has said what it has, or is
 *  let go: the hub accounts (its boss's, for chat and the Floor) are read
 *  again then. */
export function watchMachines(side: MachineSide = nativeMachines, changed: () => void = () => {}): () => void {
  const open = new Map<MachineId, () => void>();
  const loaded = (s: ReturnType<typeof useDesk.getState>) =>
    Object.entries(s.engines)
      .filter(([id, e]) => open.has(id) && e.loaded)
      .map(([id]) => id)
      .sort()
      .join(" ");
  const stopLoaded = useDesk.subscribe((s, before) => {
    if (s.engines !== before.engines && loaded(s) !== loaded(before)) changed();
  });
  let gone = false;
  let listing: Promise<void> | null = null;
  let again = false;

  const sync = (machines: Machine[]) => {
    useMachines.setState({ machines, listed: true });
    const before = [...open.keys()].sort().join(" ");
    for (const m of machines) {
      const was = open.has(m.id);
      if (drivable(m.state, was)) {
        if (!was) open.set(m.id, useDesk.getState().connectMachine(m.id, side.transport(m.id)));
      } else if (was) {
        open.get(m.id)!();
        open.delete(m.id);
      }
    }
    for (const [id, stop] of [...open]) {
      if (machines.some((m) => m.id === id)) continue;
      stop();
      open.delete(id);
    }
    if ([...open.keys()].sort().join(" ") !== before) changed();
  };

  const list = (): void => {
    if (listing) {
      again = true;
      return;
    }
    listing = side
      .list()
      .then((rows) => {
        if (!gone) sync((Array.isArray(rows) ? rows : []).flatMap((r) => readMachine(r) ?? []));
      })
      .catch((e: unknown) => console.warn("machines:", e))
      .finally(() => {
        listing = null;
        if (again && !gone) {
          again = false;
          list();
        }
      });
  };

  const stopHearing = side.changed(list);
  list();
  return () => {
    gone = true;
    stopHearing();
    stopLoaded();
    for (const stop of open.values()) stop();
    open.clear();
  };
}
