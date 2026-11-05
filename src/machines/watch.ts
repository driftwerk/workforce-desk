// A terminal opened on a machine, from Settings → Machines.

import type { PaneContent } from "../grids/engine";
import { createGrid, deliver, shownGrid, useGrids } from "../grids/store";
import { useDesk } from "../hub/store";
import { useUi } from "../shell/ui";
import { LOCAL, type MachineId } from "./engines";

/** A new terminal on `machine`, in the grid the Grids view shows (or a new
 *  one), shown. */
export const openTerminalOn = (machine: MachineId): void => {
  const grid = shownGrid(useGrids.getState())?.id ?? createGrid();
  const content: PaneContent = machine === LOCAL ? { kind: "terminal", terminalId: null } : { kind: "terminal", terminalId: null, machine };
  deliver(grid, content);
  useUi.getState().closeSettings();
  useDesk.getState().setView("grids");
};
