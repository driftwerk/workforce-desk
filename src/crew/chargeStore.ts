import { create } from "zustand";
import { useChat } from "../chat/store";
import { deskListeners, useDesk } from "../hub/store";
import type { ChargeView, DeskEvent } from "../hub/types";
import { withWheel } from "../line/rows";
import { useLine } from "../line/store";
import { useOverview } from "../overview/store";
import { useLocalAgent } from "../overview/people";
import type { Boss, ChargeVerb } from "./charge";

interface ChargeState {
  /** The sessions a boss runs now, by session id. */
  bySession: Record<string, ChargeView>;
  /** The hub keeps charges: false once it said it doesn't (an older one). */
  supported: boolean | null;
  load: () => Promise<void>;
  /** A charge the hub announced, or answered with. */
  heard: (c: ChargeView) => void;
  /** Does what the person chose for `sessionId`; the hub's refusal is
   *  thrown in its own words. */
  act: (sessionId: string, verb: ChargeVerb) => Promise<void>;
}

/** `all` with `c` as it now stands: a released one gone. */
export const withCharge = (all: Record<string, ChargeView>, c: ChargeView): Record<string, ChargeView> => {
  if (c.releasedAt) {
    if (!(c.session in all)) return all;
    const { [c.session]: _, ...rest } = all;
    return rest;
  }
  return { ...all, [c.session]: c };
};

/** Bumped by each charge heard: a read that began before it is older. */
let heardCount = 0;

export const useCharges = create<ChargeState>((set, get) => ({
  bySession: {},
  supported: null,
  load: async () => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    const was = heardCount;
    try {
      const list = await hub.charges();
      // Another hub by now, or a charge heard since: what was read is older.
      if (useDesk.getState().hub !== hub || heardCount !== was) return;
      set({ bySession: Object.fromEntries((list ?? []).map((c) => [c.session, named(c)])), supported: list !== null });
    } catch {
      // Kept as last read; the next snapshot reads them again.
    }
  },
  heard: (heard) => {
    heardCount++;
    const c = named(heard);
    const was = get().bySession[c.session];
    set((s) => ({ bySession: withCharge(s.bySession, c), supported: true }));
    // Why the boss's messages wait changes with the wheel: at once as far
    // as Desk can tell, then as the hub says on reading the thread again.
    if (!was || was.wheel !== c.wheel || !!c.releasedAt) rewait(c.session, !c.releasedAt && c.wheel !== "boss");
  },
  act: async (sessionId, verb) => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    const c =
      verb === "hand"
        ? await hub.handTo(sessionId)
        : verb === "release"
          ? await hub.releaseCharge(sessionId)
          : await hub.setWheel(sessionId, verb === "drive" ? "person_pinned" : "boss");
    get().heard(c);
  },
}));

/** `c` with its boss's name as the roster says it; "" where neither the
 *  roster nor the hub knows it (the hub then sends its id). */
const named = (c: ChargeView): ChargeView => {
  const { hubs, roster } = useChat.getState();
  const local = hubs.find((h) => h.local);
  const agent = local && roster.find((a) => a.hubId === local.id && a.id === c.boss);
  const name = agent?.name ?? (c.bossName === c.boss ? "" : c.bossName);
  return name === c.bossName ? c : { ...c, bossName: name };
};

const rewait = (sessionId: string, driving: boolean) => {
  const line = useLine.getState();
  const list = line.threads[sessionId];
  if (!list) return;
  const next = withWheel(list, sessionId, driving);
  if (next !== list) useLine.setState((s) => ({ threads: { ...s.threads, [sessionId]: next } }));
  void line.load(sessionId);
};

/** The charge on `sessionId`, if a boss runs it. */
export const useCharge = (sessionId: string | null | undefined): ChargeView | undefined =>
  useCharges((s) => (sessionId ? s.bySession[sessionId] : undefined));

/** The boss sessions can be handed to: the overseer, by its name. */
export const useBoss = (): Boss | null => {
  const manager = useOverview((s) => s.manager);
  const agent = useLocalAgent(manager?.agentId);
  if (!manager?.agentId) return null;
  return { id: manager.agentId, name: agent?.name ?? "", level: manager.level };
};

const onEvent = (e: DeskEvent) => {
  const s = useCharges.getState();
  if (e.type === "charge") s.heard(e.charge);
  // Read again on every snapshot (a hub that had none may have been
  // updated meanwhile).
  else if (e.type === "snapshot") void s.load();
  else if (e.type === "removed" && e.id in s.bySession) {
    const { [e.id]: _, ...rest } = s.bySession;
    useCharges.setState({ bySession: rest });
  }
};
deskListeners.add(onEvent);

// Another hub (or none): what the last one said is no longer so.
useDesk.subscribe((now, before) => {
  if (now.hub !== before.hub) useCharges.setState({ bySession: {}, supported: null });
});

// Names the roster brings after the charges came.
useChat.subscribe((now, before) => {
  if (now.roster === before.roster && now.hubs === before.hubs) return;
  const { bySession } = useCharges.getState();
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(bySession).map(([id, c]) => {
      const n = named(c);
      if (n !== c) changed = true;
      return [id, n];
    }),
  );
  if (changed) useCharges.setState({ bySession: next });
});
