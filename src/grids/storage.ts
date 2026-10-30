// Where grids are kept: Desk's restore store (`deskState`, restore/boot.ts),
// under the `grid.` key family — in Desk's own file at once and on the hub's
// Desk state store shortly after, so they come back after a hub restart, a
// quit, a crash or a restart of the computer.
//
// Grids use only this slice of it, which keeps the grid store testable
// against a store with an in-memory file and hub.

import type { DeskStateStore } from "../restore/store";

export type GridStorage = Pick<DeskStateStore, "get" | "set" | "remove" | "subscribe">;

export const GRID_PREFIX = "grid.";
