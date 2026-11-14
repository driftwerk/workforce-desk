import { useMemo } from "react";
import { useBoard } from "../board/store";
import { useChat } from "../chat/store";
import { agentKey } from "../chat/types";
import { useSessionNames } from "../groups/names";
import { useLayout } from "../groups/store";
import { useGrids } from "../grids/store";
import { machineName, useMachines } from "../hub/engines";
import { LOCAL, sessionKey, splitKey } from "../hub/machines";
import { useDesk } from "../hub/store";
import type { Place } from "./places";

/** Every place a rule can name, by its key, as Desk shows them now: the
 *  sidebar's groups, the boards, the grids, the sessions (on every
 *  machine) and the crew but `self`. A session on a machine is said not
 *  to be shared yet unless `fromMachines`: machines share with agents on
 *  other hubs alone (Sees K7). */
export function usePlaces(self: string, fromMachines = false): Map<string, Place> {
  const groups = useLayout().groups;
  const boards = useBoard((s) => s.boards);
  const order = useGrids((s) => s.order);
  const grids = useGrids((s) => s.grids);
  const sessions = useDesk((s) => s.sessions);
  const names = useSessionNames();
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  const machines = useMachines((s) => s.machines);
  return useMemo(() => {
    const out = new Map<string, Place>();
    for (const g of groups) out.set(`group:${g.id}`, { place: `group:${g.id}`, kind: "group", name: g.name, sub: "and the sessions that join it" });
    for (const b of Object.values(boards).sort((a, b) => a.name.localeCompare(b.name)))
      out.set(`board:${b.id}`, { place: `board:${b.id}`, kind: "board", name: b.name, sub: "its tickets and the sessions they’re assigned to" });
    for (const id of order) {
      const g = grids[id];
      if (g) out.set(`grid:${g.id}`, { place: `grid:${g.id}`, kind: "grid", name: g.name, sub: "the sessions in its panes" });
    }
    for (const s of Object.values(sessions).sort((a, b) => (names[sessionKey(a)] ?? a.name).localeCompare(names[sessionKey(b)] ?? b.name))) {
      const key = sessionKey(s);
      const { machine } = splitKey(key);
      out.set(`session:${key}`, {
        place: `session:${key}`,
        kind: "session",
        name: names[key] ?? s.name,
        sub: machine === LOCAL ? undefined : fromMachines ? `on ${machineName(machine)}` : `on ${machineName(machine)} · not shared yet`,
      });
    }
    for (const a of roster) {
      const key = agentKey(a);
      if (key === self) continue;
      const hub = hubs.find((h) => h.id === a.hubId);
      out.set(`agent:${key}`, { place: `agent:${key}`, kind: "agent", name: a.name, sub: hub && !hub.local ? `on ${hub.label}` : "the sessions they run" });
    }
    return out;
  }, [groups, boards, order, grids, sessions, names, roster, hubs, machines, self, fromMachines]);
}
