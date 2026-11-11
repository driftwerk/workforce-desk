// The order the sidebar lists boards in, as the person dragged them: kept
// under `sidebar.boards` in Desk's restore store, as the rooms' order is.
// Boards it doesn't name yet come after, oldest first; boards the hub no
// longer has are left out (and drop out of it at the next move).

import { create } from "zustand";
import type { Board } from "../hub/types";
import type { Restorable } from "../restore/boot";
import { moved, nudged } from "../ui/reorder";
import { useBoard } from "./store";

export const BOARD_ORDER_KEY = "sidebar.boards";

export const useBoardOrder = create<{ order: string[] }>(() => ({ order: [] }));

const readOrder = (v: unknown): string[] => {
  const order = (v as { order?: unknown } | null)?.order;
  return Array.isArray(order) ? order.filter((x): x is string => typeof x === "string") : [];
};

const oldestFirst = (a: Board, b: Board) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name);

/** The boards in the person's order: those it names, then the rest,
 *  oldest first (as the board's own menu lists them). */
export const arrangedBoards = (boards: Readonly<Record<string, Board>>, order: readonly string[]): Board[] => {
  const named = new Set(order);
  const first = order.flatMap((id) => boards[id] ?? []);
  return [...first, ...Object.values(boards).filter((b) => !named.has(b.id)).sort(oldestFirst)];
};

const shown = () => arrangedBoards(useBoard.getState().boards, useBoardOrder.getState().order).map((b) => b.id);

/** Moves board `id` before board `before` (last when null). */
export const moveBoard = (id: string, before: string | null): void => {
  const next = moved(shown(), id, before);
  if (next) useBoardOrder.setState({ order: next });
};

/** Moves board `id` one place up or down; false when it's already at that end. */
export const nudgeBoard = (id: string, by: -1 | 1): boolean => {
  const next = nudged(shown(), id, by);
  if (next) useBoardOrder.setState({ order: next });
  return !!next;
};

export const boardOrder: Restorable = {
  key: BOARD_ORDER_KEY,
  read: () => ({ order: useBoardOrder.getState().order }),
  write: (v) => useBoardOrder.setState({ order: readOrder(v) }),
  subscribe: (onChange) => useBoardOrder.subscribe(onChange),
};
