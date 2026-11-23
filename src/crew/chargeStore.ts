import { useEffect } from "react";
import { create } from "zustand";
import { useChat } from "../chat/store";
import { keyOf, LOCAL, machineOf, splitKey, type MachineId } from "../hub/machines";
import { engineListeners, hubOf, useDesk, type EngineEvent } from "../hub/store";
import type { ChargeView } from "../hub/types";
import { withWheel } from "../line/rows";
import { useLine } from "../line/store";
import { useOverview } from "../overview/store";
import { useLocalAgent } from "../overview/people";
import { invoke } from "../platform";
import { bossOfGroup } from "../groups/bosses";
import { UNGROUPED } from "../groups/model";
import { useLayout } from "../groups/store";
import { takenBack, type Boss, type ChargeVerb } from "./charge";
import { groupOfSession, isServed, useGrantBossOf } from "./grantBoss";

interface ChargeState {
  /** The sessions a boss runs now, by session key (see `keyOf`): each
   *  engine's boss runs that engine's sessions. */
  bySession: Record<string, ChargeView>;
  /** The sessions the person took back from their boss, by session key, as
   *  the hub keeps them: theirs until handed to a boss again. */
  released: Record<string, ChargeView>;
  /** This computer's hub keeps charges: false once it said it doesn't (an
   *  older one). */
  supported: boolean | null;
  /** Reads engine `machine`'s charges (this computer's when none). */
  load: (machine?: MachineId) => Promise<void>;
  /** A charge `machine`'s engine announced, or answered with. */
  heard: (c: ChargeView, machine?: MachineId) => void;
  /** Does what the person chose for session `key`, on its engine; the
   *  engine's refusal is thrown in its own words. A hand to a boss on
   *  another hub names it, so the engine hands it to that one or none. */
  act: (key: string, verb: ChargeVerb, boss?: Boss | null) => Promise<void>;
}

/** `all` but those whose key is in `keys`. */
const without = (all: Record<string, ChargeView>, keys: Iterable<string>): Record<string, ChargeView> => {
  const gone = new Set(keys);
  return [...gone].some((k) => k in all) ? Object.fromEntries(Object.entries(all).filter(([k]) => !gone.has(k))) : all;
};

/** `all` with `c` (on `machine`) as it now stands: a released one gone. */
export const withCharge = (all: Record<string, ChargeView>, c: ChargeView, machine: MachineId = LOCAL): Record<string, ChargeView> => {
  const key = keyOf(machine, c.session);
  return c.releasedAt ? without(all, [key]) : { ...all, [key]: c };
};

/** `taken` with `c` (on `machine`) as it now stands: there while the
 *  person took it back, gone once a boss runs it or let it go. */
const withTakenBack = (taken: Record<string, ChargeView>, c: ChargeView, machine: MachineId = LOCAL): Record<string, ChargeView> => {
  const key = keyOf(machine, c.session);
  return takenBack(c) ? { ...taken, [key]: c } : without(taken, [key]);
};

/** Charges heard from each engine, by machine: a read of an engine's that
 *  began before one of its own was heard is older (another engine's says
 *  nothing about it). */
const heardCount = new Map<MachineId, number>();
const heardOf = (machine: MachineId): number => heardCount.get(machine) ?? 0;

/** Every charge but `machine`'s. */
const others = (all: Record<string, ChargeView>, machine: MachineId): Record<string, ChargeView> =>
  Object.fromEntries(Object.entries(all).filter(([k]) => splitKey(k).machine !== machine));

export const useCharges = create<ChargeState>((set, get) => ({
  bySession: {},
  released: {},
  supported: null,
  load: async (machine = LOCAL) => {
    const hub = hubOf(machine);
    if (!hub) return;
    const was = heardOf(machine);
    try {
      const list = await hub.charges();
      // Another hub by now, or a charge heard since: what was read is older.
      if (hubOf(machine) !== hub || heardOf(machine) !== was) return;
      const read = (list ?? []).map((c) => named(c, machine));
      const keyed = (cs: ChargeView[]) => Object.fromEntries(cs.map((c) => [keyOf(machine, c.session), c]));
      const mine = keyed(read.filter((c) => !c.releasedAt));
      const back = keyed(read.filter(takenBack));
      set((s) => ({ bySession: { ...others(s.bySession, machine), ...mine }, released: { ...others(s.released, machine), ...back }, ...(machine === LOCAL ? { supported: list !== null } : {}) }));
    } catch {
      // Kept as last read; the next snapshot reads them again.
    }
  },
  heard: (heard, machine = LOCAL) => {
    heardCount.set(machine, heardOf(machine) + 1);
    const c = named(heard, machine);
    const key = keyOf(machine, c.session);
    const was = get().bySession[key];
    set((s) => ({ bySession: withCharge(s.bySession, c, machine), released: withTakenBack(s.released, c, machine), ...(machine === LOCAL ? { supported: true } : {}) }));
    // Why the boss's messages wait changes with the wheel: at once as far
    // as Desk can tell, then as the hub says on reading the thread again.
    if (!was || was.wheel !== c.wheel || !!c.releasedAt) rewait(key, c.session, !c.releasedAt && c.wheel !== "boss");
  },
  act: async (key, verb, boss) => {
    const { machine, id } = splitKey(key);
    const hub = hubOf(machine);
    if (!hub) return;
    const c =
      verb === "hand"
        ? await hub.handTo(id, isServed(boss) ? boss?.id : undefined)
        : verb === "release"
          ? await hub.releaseCharge(id)
          : await hub.setWheel(id, verb === "drive" ? "person_pinned" : "boss");
    get().heard(c, machine);
  },
}));

/** The name the roster gives agent `id` of `machine`'s engine. */
const rosterName = (machine: MachineId, id: string): string | undefined => {
  const { hubs, roster } = useChat.getState();
  const hub = hubs.find((h) => (machine === LOCAL ? h.local : h.machine === machine));
  return hub ? roster.find((a) => a.hubId === hub.id && a.id === id)?.name : undefined;
};

/** `c` with its boss's name as the roster says it; "" where neither the
 *  roster nor the hub knows it (the hub then sends its id). */
const named = (c: ChargeView, machine: MachineId = LOCAL): ChargeView => {
  const name = rosterName(machine, c.boss) ?? (c.bossName === c.boss ? "" : c.bossName);
  return name === c.bossName ? c : { ...c, bossName: name };
};

/** Session `key`'s line (its id on its engine is `id`) as the wheel now
 *  stands, and read again. */
const rewait = (key: string, id: string, driving: boolean) => {
  const line = useLine.getState();
  const list = line.threads[key];
  if (!list) return;
  const next = withWheel(list, id, driving);
  if (next !== list) useLine.setState((s) => ({ threads: { ...s.threads, [key]: next } }));
  void line.load(key);
};

/** The charge on `sessionId`, if a boss runs it. */
export const useCharge = (sessionId: string | null | undefined): ChargeView | undefined =>
  useCharges((s) => (sessionId ? s.bySession[sessionId] : undefined));

/** The released charge on `sessionId` while it is the person's: they took
 *  it back, and it hasn't ended. */
export const useTakenBack = (sessionId: string | null | undefined): ChargeView | undefined => {
  const c = useCharges((s) => (sessionId ? s.released[sessionId] : undefined));
  const ended = useDesk((s) => (sessionId ? s.sessions[sessionId]?.state === "closed" : false));
  return ended ? undefined : c;
};

/** The boss session `s` can be handed to: the one its group's grant names
 *  on another hub, wherever the session runs (machines' sessions too); else
 *  this computer's, for its own sessions and a machine's alike. A machine
 *  has no boss of its own (its hub serves no agents): its sessions go to
 *  the boss here of their group, which the machine's grant names. */
export const useBossOf = (s: { id: string; machine?: MachineId | null } | null | undefined): Boss | null => {
  const local = useBoss();
  const home = useHomeBossOf(s);
  const granted = useGrantBossOf(s);
  if (granted.boss) return granted.boss;
  // Linked to a boss on another hub that doesn't run sessions now: no one.
  if (granted.bossed) return null;
  return machineOf(s) === LOCAL ? local : home;
};

/** What a machine's grant names this computer's boss as. */
const HOME = "home";

/** How long what Desk keeps on the machines, as read, is taken as still so. */
export const CARRIED_FRESH_MS = 25_000;

interface HomeGrantsState {
  /** Each machine's groups whose grant Desk keeps there for a boss on this
   *  computer, with that boss's agent id, as last read. */
  byMachine: Record<string, Record<string, string>>;
  /** When the last read was asked for: what it read was so by then. */
  readAt: number;
  /** Reads them again unless they were read just now. */
  ensure: () => void;
}

let readingCarried = false;

export const useHomeGrants = create<HomeGrantsState>((set, get) => ({
  byMachine: {},
  readAt: 0,
  ensure: () => {
    if (readingCarried || Date.now() - get().readAt < CARRIED_FRESH_MS) return;
    readingCarried = true;
    const readAt = Date.now();
    invoke<Record<string, Record<string, string>> | null>("local_boss_grants")
      // A Desk with no native side to ask (the browser) keeps none.
      .then((byMachine) => set({ byMachine: byMachine ?? {}, readAt }))
      // Kept as last read, and not asked again until it would be anyway.
      .catch(() => set({ readAt }))
      .finally(() => {
        readingCarried = false;
      });
  },
}));

/** The boss here of `s`'s group (the main overseer for Ungrouped), while
 *  the machine holds the grant Desk keeps there for it, which names it
 *  there (`home/<agent>`); no one otherwise. */
const useHomeBossOf = (s: { id: string; machine?: MachineId | null } | null | undefined): Boss | null => {
  const layout = useLayout();
  const manager = useOverview((st) => st.manager);
  const group = s ? groupOfSession(layout, s) : UNGROUPED;
  const machine = machineOf(s);
  const own = group === UNGROUPED ? manager : bossOfGroup(manager, group);
  const carried = useHomeGrants((st) => st.byMachine[machine]?.[group]);
  // Read while shown, and again as what was read goes stale.
  useEffect(() => {
    if (machine === LOCAL) return;
    const { ensure } = useHomeGrants.getState();
    ensure();
    const again = setInterval(ensure, CARRIED_FRESH_MS);
    return () => clearInterval(again);
  }, [machine]);
  const agent = useLocalAgent(own?.agentId);
  if (!own?.agentId || machine === LOCAL || carried !== own.agentId) return null;
  const name = agent?.name ?? ("name" in own ? own.name : null) ?? own.agentId;
  return { id: `${HOME}/${own.agentId}`, name, level: own.level, served: true };
};

/** The boss sessions can be handed to: the overseer, by its name. */
export const useBoss = (): Boss | null => {
  const manager = useOverview((s) => s.manager);
  const agent = useLocalAgent(manager?.agentId);
  if (!manager?.agentId) return null;
  return { id: manager.agentId, name: agent?.name ?? manager.agentId, level: manager.level };
};

const onEvent = (e: EngineEvent) => {
  const s = useCharges.getState();
  const machine = machineOf(e);
  const key = e.type === "removed" ? keyOf(machine, e.id) : null;
  if (e.type === "charge") s.heard(e.charge, machine);
  // Read again on every snapshot (a hub that had none may have been
  // updated meanwhile).
  else if (e.type === "snapshot") void s.load(machine);
  else if (key && (key in s.bySession || key in s.released)) {
    useCharges.setState({ bySession: without(s.bySession, [key]), released: without(s.released, [key]) });
  }
};
engineListeners.add(onEvent);

// Another hub (or none): what the last one said is no longer so; a machine
// let go takes its charges with it.
useDesk.subscribe((now, before) => {
  if (now.hub !== before.hub) useCharges.setState((s) => ({ bySession: others(s.bySession, LOCAL), released: others(s.released, LOCAL), supported: null }));
  if (now.engines === before.engines) return;
  const gone = Object.keys(before.engines).filter((m) => m !== LOCAL && !now.engines[m]);
  for (const m of gone) useCharges.setState((s) => ({ bySession: others(s.bySession, m), released: others(s.released, m) }));
});

// Names the roster brings after the charges came.
useChat.subscribe((now, before) => {
  if (now.roster === before.roster && now.hubs === before.hubs) return;
  const { bySession, released } = useCharges.getState();
  let changed = false;
  const renamed = (all: Record<string, ChargeView>) =>
    Object.fromEntries(
      Object.entries(all).map(([key, c]) => {
        const n = named(c, splitKey(key).machine);
        if (n !== c) changed = true;
        return [key, n];
      }),
    );
  const next = { bySession: renamed(bySession), released: renamed(released) };
  if (changed) useCharges.setState(next);
});
