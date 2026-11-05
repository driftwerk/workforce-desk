// What the machines' UI uses of the page's engines: MD4's (hub/machines.ts,
// hub/engines.ts, `useDesk.engines`), in one place.

import type { Session } from "../hub/types";
import { machineOf, type MachineId } from "../hub/machines";

export { keyOf, LOCAL, machineOf, readMachine, sessionKey, splitKey } from "../hub/machines";
export type { Machine, MachineId, MachineState } from "../hub/machines";
export { machineName, useMachines } from "../hub/engines";
export { hubOf, useHubOf } from "../hub/store";

/** Every session on `machine`, as `useDesk` keeps them. */
export const sessionsOn = (sessions: Record<string, Session>, machine: MachineId): Session[] =>
  Object.values(sessions).filter((s) => machineOf(s) === machine);
