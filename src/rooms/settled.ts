import { create } from "zustand";
import type { ActivityEvent } from "../hub/types";

// What the boss told you of and was settled since, by item: heard live
// from the hub's "settled" events, so an update already on screen folds
// it at once. A page read again says the same in its items' `settledBy`.

type By = "you" | "session";

export const useSettled = create<{ by: Readonly<Record<string, By>> }>(() => ({ by: {} }));

/** Takes a "settled" event; any other is left alone. */
export function heardSettled(e: ActivityEvent): void {
  if (e.kind !== "settled") return;
  const id = e.detail?.itemId;
  const by = e.detail?.by;
  if (!id || (by !== "you" && by !== "session")) return;
  if (useSettled.getState().by[id] === by) return;
  useSettled.setState((s) => ({ by: { ...s.by, [id]: by } }));
}

/** How item `id` was settled: as the update said, or as heard since. */
export const useSettledBy = (id: string, said: By | null | undefined): By | null =>
  useSettled((s) => s.by[id] ?? said ?? null);
