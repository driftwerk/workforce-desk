import { DragDropProvider, DragOverlay } from "@dnd-kit/react";
import { useRef } from "react";
import { create } from "zustand";
import { ENGINE_SHORT } from "../engines/engines";
import { lookOf, waitsOnYou } from "../floor/background";
import { DragChip, PLUGINS, SENSORS, SortRow } from "../groups/rows";
import { useSessionNames } from "../groups/names";
import { sortedSessions, useDesk } from "../hub/store";
import { useHost } from "../shell/host";
import { LOCAL, machineOf, sessionKey, useMachines, type Machine, type MachineId } from "./engines";
import { acrossMachines, dotOf, nameOfMachine, offlineWord, thisComputer, thisComputerLower } from "./words";

/** What a drag across machines was refused with, for a few seconds. */
export const useRefusal = create<{ text: string | null; n: number }>(() => ({ text: null, n: 0 }));

/** How long the refusal shows. */
export const REFUSAL_MS = 5000;

/** The machine whose sidebar section is under `at`, if any: looked for
 *  through everything there, as grids/drag.ts does, since the dragged chip
 *  is always under the pointer. */
export const machineAt = (at: { x: number; y: number }): MachineId | null => {
  const els = typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(at.x, at.y) : [];
  for (const el of els) {
    const m = el instanceof HTMLElement ? el.closest<HTMLElement>("[data-machine]")?.dataset.machine : undefined;
    if (m) return m;
  }
  return null;
};

/** A session of `from`'s dropped at `at`: refused, saying why, when that's
 *  another machine's section. Whether it was. */
export const refuseAcross = (from: MachineId, at: { x: number; y: number }): boolean => {
  const to = machineAt(at);
  if (!to || to === from) return false;
  const machines = useMachines.getState().machines;
  const n = useRefusal.getState().n + 1;
  const platform = useHost.getState().platform;
  useRefusal.setState({ text: acrossMachines(nameOfMachine(from, machines, platform), nameOfMachine(to, machines, platform), from === LOCAL ? thisComputerLower(platform) : null), n });
  setTimeout(() => useRefusal.getState().n === n && useRefusal.setState({ text: null }), REFUSAL_MS);
  return true;
};

/** This computer's heading over its groups, once there's a machine besides. */
export function ThisComputerHeading() {
  const any = useMachines((s) => s.machines.length > 0);
  const platform = useHost((h) => h.platform);
  if (!any) return null;
  return <span className="ov-label side-machine-head">{thisComputer(platform)}</span>;
}

const STATE_WORD: Partial<Record<string, string>> = { blocked: "needs you", asking: "asked" };

/** One machine's section: its name with its status dot, and its sessions.
 *  They're dragged onto a grid's pane, or nowhere: another machine's
 *  section refuses them. */
function MachineSection({ machine }: { machine: Machine }) {
  const all = useDesk((s) => s.sessions);
  const openId = useDesk((s) => s.openId);
  const open = useDesk((s) => s.open);
  const names = useSessionNames();
  const rows = useRef(new Map<string, HTMLElement>());
  const justDragged = useRef(false);
  const sessions = sortedSessions(all).filter((s) => machineOf(s) === machine.id && s.state !== "closed");
  const byKey = new Map(sessions.map((s) => [sessionKey(s), s]));
  const off = offlineWord(machine.state);
  const type = `machine:${machine.id}`;
  return (
    <DragDropProvider
      sensors={SENSORS}
      plugins={PLUGINS}
      onDragEnd={(e) => {
        justDragged.current = true;
        setTimeout(() => (justDragged.current = false), 0);
        if (!e.canceled) refuseAcross(machine.id, e.operation.position.current);
      }}
    >
      <div className="side-section" role="region" aria-label={machine.name} data-machine={machine.id}>
        <span className="ov-label side-machine-head">
          <span className={`dot dot-${dotOf(machine.state)}`} aria-hidden="true" />
          {machine.name}
          {off && <span className="side-machine-off">{off}</span>}
        </span>
        <div className="grp">
          <ul className="grp-items" aria-label={`Sessions on ${machine.name}`}>
            {sessions.map((s) => {
              const key = sessionKey(s);
              const name = names[key] ?? s.name;
              return (
                <SortRow
                  key={key}
                  id={key}
                  type={type}
                  lineBefore={false}
                  on={openId === key}
                  lead={<span className={`dot dot-${lookOf(s)}`} aria-hidden="true" />}
                  name={name}
                  nameClass="mono"
                  meta={<span className={`gi-meta small ${waitsOnYou(s) ? "state-blocked" : "faint"}`}>{STATE_WORD[s.state] ?? ENGINE_SHORT[s.engine]}</span>}
                  title={`${name} on ${machine.name}`}
                  data={{ "data-item": key }}
                  register={(el) => (el ? rows.current.set(key, el) : rows.current.delete(key))}
                  onOpen={() => !justDragged.current && open(key)}
                  onNudge={() => undefined}
                  onMenu={() => undefined}
                />
              );
            })}
            {!sessions.length && <li className="faint small side-machine-empty">No sessions</li>}
          </ul>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {(source) => {
          const s = byKey.get(String(source.id));
          return s ? (
            <DragChip mono>
              <span className={`dot dot-${lookOf(s)}`} />
              {names[String(source.id)] ?? s.name}
            </DragChip>
          ) : null;
        }}
      </DragOverlay>
    </DragDropProvider>
  );
}

/** A heading per machine, after this computer's groups, each with its own
 *  sessions; and what a drag across machines was refused with. */
export function SidebarMachines() {
  const machines = useMachines((s) => s.machines);
  const refusal = useRefusal((s) => s.text);
  if (!machines.length) return null;
  return (
    <>
      {machines.map((m) => (
        <MachineSection key={m.id} machine={m} />
      ))}
      <p className="small state-blocked side-refusal" role="status" hidden={!refusal}>
        {refusal}
      </p>
    </>
  );
}
