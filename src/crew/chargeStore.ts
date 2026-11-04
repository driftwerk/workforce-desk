import { create } from "zustand";
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

export const useCharges = create<ChargeState>((set, get) => ({
  bySession: {},
  supported: null,
  load: async () => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    try {
      const list = await hub.charges();
      if (useDesk.getState().hub !== hub) return;
      set({ bySession: Object.fromEntries((list ?? []).map((c) => [c.session, c])), supported: list !== null });
    } catch {
      // Kept as last read; the next snapshot reads them again.
    }
  },
  heard: (c) => {
    const was = get().bySession[c.session];
    set((s) => ({ bySession: withCharge(s.bySession, c), supported: true }));
    // Why the boss's messages wait (or that they no longer do) changes
    // with the wheel; the hub says what became of each as it moves on.
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

const rewait = (sessionId: string, driving: boolean) => {
  const list = useLine.getState().threads[sessionId];
  if (!list) return;
  const next = withWheel(list, sessionId, driving);
  if (next !== list) useLine.setState((s) => ({ threads: { ...s.threads, [sessionId]: next } }));
};

/** The charge on `sessionId`, if a boss runs it. */
export const useCharge = (sessionId: string | null | undefined): ChargeView | undefined =>
  useCharges((s) => (sessionId ? s.bySession[sessionId] : undefined));

/** The boss sessions can be handed to: the overseer, by its name. */
export const useBoss = (): Boss | null => {
  const manager = useOverview((s) => s.manager);
  const agent = useLocalAgent(manager?.agentId);
  if (!manager?.agentId) return null;
  return { id: manager.agentId, name: agent?.name ?? "your overseer", level: manager.level };
};

const onEvent = (e: DeskEvent) => {
  const s = useCharges.getState();
  if (e.type === "charge") s.heard(e.charge);
  else if (e.type === "snapshot") {
    if (s.supported !== false) void s.load();
  } else if (e.type === "removed" && e.id in s.bySession) {
    const { [e.id]: _, ...rest } = s.bySession;
    useCharges.setState({ bySession: rest });
  }
};
deskListeners.add(onEvent);
