// A terminal opened on a machine, from Settings → Machines.

import { newTerminalHere } from "../grids/store";
import { useDesk } from "../hub/store";
import { useUi } from "../shell/ui";
import type { MachineId } from "./engines";

/** A new terminal on `machine`, in the grid the Grids view shows (or a new
 *  one), as the New terminal shortcut puts one; shown. */
export const openTerminalOn = (machine: MachineId): void => {
  newTerminalHere(machine);
  useUi.getState().closeSettings();
  useDesk.getState().setView("grids");
};
