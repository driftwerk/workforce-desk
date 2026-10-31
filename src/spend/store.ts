import { create } from "zustand";
import { deskListeners, useDesk } from "../hub/store";
import type { SpendPeriod, SpendView } from "../hub/types";

/** The Floor's periods: today and this week, in the hub's timezone. */
export type FloorPeriod = Extract<SpendPeriod, "day" | "week">;

/** Sessions read for each period: enough for every session card's strip. */
const LIMIT = 200;
/** How long a burst of spend events waits to be one read. */
const SETTLE_MS = 2000;

interface SpendState {
  /** By period, each session's spend; null before the first read, or from
   *  a hub without a ledger. */
  views: Partial<Record<FloorPeriod, SpendView | null>>;
  /** The hub has a ledger: false once it said it hasn't. */
  supported: boolean | null;
  failed: boolean;
  load: () => Promise<void>;
}

export const useSpend = create<SpendState>((set) => ({
  views: {},
  supported: null,
  failed: false,
  load: async () => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    try {
      const [day, week] = await Promise.all([hub.spend("day", "session", LIMIT), hub.spend("week", "session", LIMIT)]);
      set({ views: { day, week }, supported: day !== null, failed: false });
    } catch {
      set({ failed: true });
    }
  },
}));

let settle: ReturnType<typeof setTimeout> | null = null;

/** Reads again once a session's spend changes, a burst read once. */
deskListeners.add((e) => {
  if (e.type !== "spend" && e.type !== "snapshot") return;
  if (useSpend.getState().supported === false) return;
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => {
    settle = null;
    void useSpend.getState().load();
  }, SETTLE_MS);
});

/** A session's spend in `period`, when it spent anything. */
export const useSessionSpend = (id: string, period: FloorPeriod) =>
  useSpend((s) => s.views[period]?.rows.find((r) => r.session === id) ?? null);
