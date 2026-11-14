import { create } from "zustand";
import { useChat } from "../chat/store";
import { keyOf, LOCAL, machineOf, splitKey, type MachineId } from "../hub/machines";
import { engineListeners, hubOf, useDesk, type EngineEvent } from "../hub/store";
import type { ChargeView } from "../hub/types";
import { withWheel } from "../line/rows";
import { useLine } from "../line/store";
import { useOverview } from "../overview/store";
import { useLocalAgent } from "../overview/people";
import type { Boss, ChargeVerb } from "./charge";
import { isServed, useGrantBossOf } from "./grantBoss";

interface ChargeState {
  /** The sessions a boss runs now, by session key (see `keyOf`): each
   *  engine's boss runs that engine's sessions. */
  bySession: Record<string, ChargeView>;
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

/** `all` with `c` (on `machine`) as it now stands: a released one gone. */
export const withCharge = (all: Record<string, ChargeView>, c: ChargeView, machine: MachineId = LOCAL): Record<string, ChargeView> => {
  const key = keyOf(machine, c.session);
  if (c.releasedAt) {
    if (!(key in all)) return all;
    const { [key]: _, ...rest } = all;
    return rest;
  }
  return { ...all, [key]: c };
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
  supported: null,
  load: async (machine = LOCAL) => {
    const hub = hubOf(machine);
    if (!hub) return;
    const was = heardOf(machine);
    try {
      const list = await hub.charges();
      // Another hub by now, or a charge heard since: what was read is older.
      if (hubOf(machine) !== hub || heardOf(machine) !== was) return;
      const mine = Object.fromEntries((list ?? []).map((c) => [keyOf(machine, c.session), named(c, machine)]));
      set((s) => ({ bySession: { ...others(s.bySession, machine), ...mine }, ...(machine === LOCAL ? { supported: list !== null } : {}) }));
    } catch {
      // Kept as last read; the next snapshot reads them again.
    }
  },
  heard: (heard, machine = LOCAL) => {
    heardCount.set(machine, heardOf(machine) + 1);
    const c = named(heard, machine);
    const key = keyOf(machine, c.session);
    const was = get().bySession[key];
    set((s) => ({ bySession: withCharge(s.bySession, c, machine), ...(machine === LOCAL ? { supported: true } : {}) }));
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

/** The boss session `s` can be handed to: the one its group's grant names
 *  on another hub, wherever the session runs (machines' sessions too); else
 *  this computer's, for its own sessions. A machine has no boss of its own
 *  (its hub serves no agents), so its other sessions are handed to none
 *  and ask the person. */
export const useBossOf = (s: { id: string; machine?: MachineId | null } | null | undefined): Boss | null => {
  const local = useBoss();
  const granted = useGrantBossOf(s);
  if (granted.boss) return granted.boss;
  // Linked to a boss on another hub that doesn't run sessions now: no one.
  if (granted.bossed) return null;
  return machineOf(s) === LOCAL ? local : null;
};

/** The boss sessions can be handed to: the overseer, by its name. */
export const useBoss = (): Boss | null => {
  const manager = useOverview((s) => s.manager);
  const agent = useLocalAgent(manager?.agentId);
  if (!manager?.agentId) return null;
  return { id: manager.agentId, name: agent?.name ?? "", level: manager.level };
};

const onEvent = (e: EngineEvent) => {
  const s = useCharges.getState();
  const machine = machineOf(e);
  const key = e.type === "removed" ? keyOf(machine, e.id) : null;
  if (e.type === "charge") s.heard(e.charge, machine);
  // Read again on every snapshot (a hub that had none may have been
  // updated meanwhile).
  else if (e.type === "snapshot") void s.load(machine);
  else if (key && key in s.bySession) {
    const { [key]: _, ...rest } = s.bySession;
    useCharges.setState({ bySession: rest });
  }
};
engineListeners.add(onEvent);

// Another hub (or none): what the last one said is no longer so; a machine
// let go takes its charges with it.
useDesk.subscribe((now, before) => {
  if (now.hub !== before.hub) useCharges.setState((s) => ({ bySession: others(s.bySession, LOCAL), supported: null }));
  if (now.engines === before.engines) return;
  const gone = Object.keys(before.engines).filter((m) => m !== LOCAL && !now.engines[m]);
  for (const m of gone) useCharges.setState((s) => ({ bySession: others(s.bySession, m) }));
});

// Names the roster brings after the charges came.
useChat.subscribe((now, before) => {
  if (now.roster === before.roster && now.hubs === before.hubs) return;
  const { bySession } = useCharges.getState();
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(bySession).map(([key, c]) => {
      const n = named(c, splitKey(key).machine);
      if (n !== c) changed = true;
      return [key, n];
    }),
  );
  if (changed) useCharges.setState({ bySession: next });
});
