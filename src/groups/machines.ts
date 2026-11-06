// One sidebar: a session on one of the person's machines sits in any of their
// groups, or Ungrouped, like one of this computer's, keyed
// `session:<machine>/<id>` (model.ts). What that needs beyond this
// computer's sessions, kept here:
// - each machine's sessions as last seen, so that while a machine is offline,
//   or Desk started without reaching it, its sessions keep their places,
//   shown offline (kept under `sidebar.machines` with the rest of what Desk
//   restores);
// - a session its machine's engine says is gone leaves the groups (this
//   computer's hub doesn't know it, so never forgets it), and a machine
//   removed from Desk takes its sessions out of them;
// - each machine's own groups, as its engine kept them before there was one
//   sidebar, merged in once (and not read again).
// Only the main window changes the groups this way: it is the one that saves
// them (see store.ts).

import { create } from "zustand";
import { useMachines } from "../hub/engines";
import { keyOf, LOCAL, machineOf, sessionKey, splitKey, type MachineId } from "../hub/machines";
import { engineListeners, useDesk, type EngineEvent } from "../hub/store";
import type { Engine, Session } from "../hub/types";
import type { Restorable } from "../restore/boot";
import { useSettings } from "../settings/store";
import { useHubLayout } from "./hubLayout";
import { dropItems, machineOfItem, mergeMachineLayout, sessionOf, type ItemKey, type Layout } from "./model";
import { layoutSettled, replaceLayout } from "./store";

export const SIDEBAR_PREFIX = "sidebar.";
export const MACHINES_KEY = "sidebar.machines";

/** A machine's session as last seen: enough to draw its row while its
 *  machine can't be reached. */
export interface Seen {
  name: string;
  /** The name you gave it there, if any. */
  displayName?: string | null;
  engine: Engine;
}

export const useMachineSessions = create<{
  /** By session key (`<machine>/<id>`). */
  seen: Record<string, Seen>;
  /** The machines whose own groups have been merged in. */
  merged: MachineId[];
}>(() => ({ seen: {}, merged: [] }));

const seenOf = (s: Session): Seen => ({ name: s.name, engine: s.engine, ...(s.displayName ? { displayName: s.displayName } : {}) });

const same = (a: Seen | undefined, b: Seen): boolean =>
  !!a && a.name === b.name && a.engine === b.engine && (a.displayName ?? null) === (b.displayName ?? null);

/** Notes machines' sessions as they are now. One that's gone is forgotten
 *  only when its engine says so (`forgetMachineSessions`): one missing here
 *  may just be on a machine that can't be reached. */
export const noteSessions = (sessions: Record<string, Session>): void => {
  const { seen } = useMachineSessions.getState();
  let next: Record<string, Seen> | null = null;
  for (const s of Object.values(sessions)) {
    if (machineOf(s) === LOCAL || s.state === "closed") continue;
    const key = sessionKey(s);
    const now = seenOf(s);
    if (same(seen[key], now)) continue;
    (next ??= { ...seen })[key] = now;
  }
  if (next) useMachineSessions.setState({ seen: next });
};

/** Whether item `key` is a machine's session that `gone` picks out (by its
 *  session key). */
const machineItem = (gone: (key: string) => boolean) => (k: ItemKey) => {
  const m = machineOfItem(k);
  return m !== null && m !== LOCAL && gone(sessionOf(k)!);
};

/** Changes to the groups waiting for them to be settled (see
 *  `layoutSettled`), in order. */
let waiting: ((l: Layout) => Layout | null)[] = [];
/** Whether this window follows the machines (the main one does). */
let following = false;

const changeWhenSettled = (change: (l: Layout) => Layout | null): void => {
  if (!following || useDesk.getState().detached) return;
  if (layoutSettled()) replaceLayout(change);
  else waiting.push(change);
};

/** Machines' sessions `gone` picks out (by session key) leave the groups,
 *  and what was seen of them is forgotten. */
export const forgetMachineSessions = (gone: (key: string) => boolean): void => {
  const pick = machineItem(gone);
  changeWhenSettled((l) => dropItems(l, pick));
  const { seen } = useMachineSessions.getState();
  if (Object.keys(seen).some(gone)) useMachineSessions.setState({ seen: Object.fromEntries(Object.entries(seen).filter(([k]) => !gone(k))) });
};

/** What machine `machine`'s event says is gone, as a test of session keys;
 *  null for none. A machine that stops answering says nothing: only its
 *  engine's own word counts. */
export const goneOn = (machine: MachineId, e: EngineEvent): ((key: string) => boolean) | null => {
  switch (e.type) {
    case "snapshot": {
      const known = new Set([...e.sessions.filter((x) => x.state !== "closed"), ...e.restore].map((x) => keyOf(machine, x.id)));
      return (key) => splitKey(key).machine === machine && !known.has(key);
    }
    case "removed":
      return (key) => key === keyOf(machine, e.id);
    case "session":
      return e.session.state === "closed" ? (key) => key === keyOf(machine, e.session.id) : null;
    default:
      return null;
  }
};

/** Machines removed from Desk (listed, and no longer there) take their
 *  sessions out of the groups; one added again merges its groups again. */
const forgetRemoved = (): void => {
  const { machines, listed } = useMachines.getState();
  if (!listed) return;
  const ids = new Set(machines.map((m) => m.id));
  const removed = (key: string) => {
    const m = splitKey(key).machine;
    return m !== LOCAL && !ids.has(m);
  };
  forgetMachineSessions(removed);
  const { merged } = useMachineSessions.getState();
  if (merged.some((m) => !ids.has(m))) useMachineSessions.setState({ merged: merged.filter((m) => ids.has(m)) });
};

/** Each machine's own groups as its engine last said them, until merged. */
const heard = new Map<MachineId, Layout>();

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Merges in the groups of each machine heard from that hasn't been, once
 *  the groups here are settled. */
const mergeHeard = (): void => {
  if (!following || useDesk.getState().detached || !layoutSettled()) return;
  const ids = new Set(useMachines.getState().machines.map((m) => m.id));
  for (const [machine, theirs] of [...heard]) {
    if (useMachineSessions.getState().merged.includes(machine)) {
      heard.delete(machine);
      continue;
    }
    if (!ids.has(machine)) continue;
    heard.delete(machine);
    replaceLayout((l) => {
      const next = mergeMachineLayout(l, machine, theirs, newId);
      return next === l ? null : next;
    });
    useMachineSessions.setState((s) => ({ merged: [...s.merged, machine] }));
  }
};

/** Once the groups are settled: what waited for them. */
const settle = (): void => {
  if (!following || useDesk.getState().detached || !layoutSettled()) return;
  const changes = waiting;
  waiting = [];
  for (const change of changes) replaceLayout(change);
  forgetRemoved();
  mergeHeard();
};

const onEngine = (e: EngineEvent): void => {
  const machine = machineOf(e);
  if (machine === LOCAL) return;
  if ((e.type === "snapshot" || e.type === "layout") && e.layout && !useMachineSessions.getState().merged.includes(machine)) heard.set(machine, e.layout);
  const gone = goneOn(machine, e);
  if (gone) forgetMachineSessions(gone);
  mergeHeard();
};

/** Follows the machines' sessions for the sidebar, in the main window:
 *  notes them, forgets the gone and the removed, and merges each machine's
 *  own groups in once. */
export function followMachineSessions(): () => void {
  following = true;
  noteSessions(useDesk.getState().sessions);
  engineListeners.add(onEngine);
  const stops = [
    useDesk.subscribe((s, before) => s.sessions !== before.sessions && noteSessions(s.sessions)),
    useMachines.subscribe((s, before) => {
      if (s.machines === before.machines && s.listed === before.listed) return;
      if (layoutSettled()) forgetRemoved();
      mergeHeard();
    }),
    useHubLayout.subscribe(settle),
    useSettings.subscribe((s, before) => s.loaded !== before.loaded && settle()),
  ];
  settle();
  return () => {
    following = false;
    waiting = [];
    heard.clear();
    engineListeners.delete(onEngine);
    for (const stop of stops) stop();
  };
}

const readSeen = (v: unknown): Record<string, Seen> => {
  const o = (v as { seen?: unknown } | null)?.seen;
  if (!o || typeof o !== "object") return {};
  return Object.fromEntries(
    Object.entries(o as Record<string, unknown>).flatMap(([k, x]) => {
      const s = x as Partial<Seen> | null;
      return s && typeof s.name === "string" && typeof s.engine === "string" && splitKey(k).machine !== LOCAL
        ? [[k, { name: s.name, engine: s.engine, ...(typeof s.displayName === "string" ? { displayName: s.displayName } : {}) }]]
        : [];
    }),
  );
};

const readMerged = (v: unknown): MachineId[] => {
  const m = (v as { merged?: unknown } | null)?.merged;
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === "string") : [];
};

/** What's kept of the machines' sessions, restored with the rest. */
export const machineSessions: Restorable = {
  key: MACHINES_KEY,
  read: () => {
    const { seen, merged } = useMachineSessions.getState();
    return { seen, merged };
  },
  write: (v) => useMachineSessions.setState({ seen: readSeen(v), merged: readMerged(v) }),
  subscribe: (onChange) => useMachineSessions.subscribe(onChange),
};
