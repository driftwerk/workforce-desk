import { LOCAL, useMachines, type MachineId } from "./engines";
import { offlineWord } from "./words";

/** "on devbox" beside a pane's or a session's name, for what runs on a
 *  machine (nothing for this computer's), with why it can't be reached
 *  when it can't. */
export function OnMachine({ machine, className = "" }: { machine: MachineId | null | undefined; className?: string }) {
  const remote = !!machine && machine !== LOCAL;
  const m = useMachines((s) => (remote ? s.machines.find((x) => x.id === machine) : undefined));
  const listed = useMachines((s) => s.listed);
  if (!remote) return null;
  if (!m && listed)
    return (
      <span className={`chip chip-machine state-blocked ${className}`} title="This machine was removed from Desk">
        machine removed
      </span>
    );
  const off = m ? offlineWord(m.state) : null;
  return (
    <span className={`chip chip-machine ${off ? "chip-machine-off" : ""} ${className}`} title={off ? `${m?.name ?? machine} is ${off}` : undefined}>
      on {m?.name ?? machine}
      {off && ` · ${off}`}
    </span>
  );
}

/** A sidebar row's machine: its name in a small tag after the session's
 *  name (none for this computer's), amber while it can't be reached, saying
 *  why in its title. */
export function MachineTag({ machine }: { machine: MachineId | null | undefined }) {
  const remote = !!machine && machine !== LOCAL;
  const m = useMachines((s) => (remote ? s.machines.find((x) => x.id === machine) : undefined));
  if (!remote) return null;
  const name = m?.name ?? machine;
  const off = m ? offlineWord(m.state) : null;
  return (
    <span className={`chip gi-machine ${off ? "chip-machine-off" : ""}`} title={off ? `${name} is ${off}` : `Runs on ${name}`}>
      {name}
    </span>
  );
}
