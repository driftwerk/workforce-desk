import { create } from "zustand";
import { deskListeners, useDesk } from "../hub/store";
import type { BreakerView, BudgetsView } from "../hub/types";

/** How long a burst of changes waits to be one read. */
const SETTLE_MS = 1000;

interface BudgetState {
  /** Null before the first read, or from a hub without budgets. */
  view: BudgetsView | null;
  /** The hub keeps budgets: false once it said it doesn't. */
  supported: boolean | null;
  failed: boolean;
  load: () => Promise<void>;
}

export const useBudgets = create<BudgetState>((set) => ({
  view: null,
  supported: null,
  failed: false,
  load: async () => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    try {
      const view = await hub.budgets();
      set({ view, supported: view !== null, failed: false });
    } catch {
      set({ failed: true });
    }
  },
}));

let settle: ReturnType<typeof setTimeout> | null = null;
const later = () => {
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => {
    settle = null;
    void useBudgets.getState().load();
  }, SETTLE_MS);
};

/** A breaker as it now stands, in place of the one it was. */
export const withBreaker = (view: BudgetsView, b: BreakerView): BudgetsView => ({
  ...view,
  breakers: [...view.breakers.filter((x) => x.subject !== b.subject), ...(b.level.level === "clear" ? [] : [b])],
});

deskListeners.add((e) => {
  if (useBudgets.getState().supported === false) return;
  if (e.type === "breaker") {
    const view = useBudgets.getState().view;
    if (view) useBudgets.setState({ view: withBreaker(view, e.breaker) });
    later();
  } else if (e.type === "budgets" || e.type === "snapshot") {
    later();
  } else if (e.type === "spend") {
    // Spend moves a standing only where there is a budget to stand against.
    const view = useBudgets.getState().view;
    if (view && (view.budgets.length > 0 || view.breakers.length > 0)) later();
  }
});

/** The breakers, as last read. */
export const useBreakers = (): readonly BreakerView[] => useBudgets((s) => s.view?.breakers ?? NONE);
const NONE: readonly BreakerView[] = [];
