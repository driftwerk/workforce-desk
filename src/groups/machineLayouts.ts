import { create } from "zustand";
import { LOCAL, machineOf, type MachineId } from "../hub/machines";
import { engineListeners, useDesk, type EngineEvent } from "../hub/store";
import type { Layout } from "./model";

// Each machine's sidebar groups, as its engine keeps them: a machine's
// sessions are grouped on the machine, under its own heading, never in this
// computer's groups (a group's boss and its lines' reach read the engine's
// own layout). Its items name its sessions by their ids on it.

export const useMachineLayouts = create<{ layouts: Record<MachineId, Layout> }>(() => ({ layouts: {} }));

const put = (machine: MachineId, layout: Layout | undefined) =>
  useMachineLayouts.setState((s) => {
    const { [machine]: _was, ...rest } = s.layouts;
    return { layouts: layout ? { ...rest, [machine]: layout } : rest };
  });

/** Keeps each machine's layout as its engine says it. */
export const heardLayout = (e: EngineEvent): void => {
  const machine = machineOf(e);
  if (machine === LOCAL) return;
  if (e.type === "snapshot") put(machine, e.layout);
  else if (e.type === "layout") put(machine, e.layout);
};
engineListeners.add(heardLayout);

// A machine let go takes its layout with it.
useDesk.subscribe((s, before) => {
  if (s.engines === before.engines) return;
  for (const m of Object.keys(useMachineLayouts.getState().layouts)) if (!s.engines[m]) put(m, undefined);
});
