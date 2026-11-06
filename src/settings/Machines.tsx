import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { useDesk } from "../hub/store";
import { AddMachine } from "../machines/AddMachine";
import { LOCAL, sessionsOn, useMachines, type Machine } from "../machines/engines";
import { native as realNative, type MachineNative } from "../machines/native";
import { SignInOn } from "../machines/SignIn";
import { openTerminalOn } from "../machines/watch";
import { dotOf, stateText, thisComputer, thisComputerLower } from "../machines/words";
import { inApp } from "../platform";
import { useHost } from "../shell/host";
import { Confirm } from "../ui/Confirm";

/** This Desk's version; null outside the app or until it's read. */
const useDeskVersion = (): string | null => {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (inApp) void getVersion().then(setVersion).catch(() => undefined);
  }, []);
  return version;
};

const sessionsText = (n: number): string => `${n} ${n === 1 ? "session" : "sessions"}`;

function MachineRow({ machine, version, native, onRemove }: { machine: Machine; version: string | null; native: MachineNative; onRemove: () => void }) {
  const count = useDesk((s) => sessionsOn(s.sessions, machine.id).length);
  const [problem, setProblem] = useState<string | null>(null);
  const s = machine.state.kind;
  const said = stateText(machine, version);
  const parts = [
    "Connected",
    sessionsText(count),
    machine.version && `Desk ${machine.version}`,
    machine.system && `Linux ${machine.system.arch}`,
  ].filter(Boolean);
  const retry = () => {
    setProblem(null);
    native.reconnect(machine.id).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
  return (
    <li className="machine-row" aria-label={machine.name}>
      <span className={`dot dot-${dotOf(machine.state)}`} aria-hidden="true" />
      <span className="machine-row-text">
        <span className="machine-row-name">
          <b>{machine.name}</b>
          {machine.target && machine.target !== machine.name && <span className="mono small muted">{machine.target}</span>}
        </span>
        {said ? (
          <span className={`small ${s === "unreachable" || s === "failed" || s === "newer" ? "state-blocked" : "muted"}`}>{said}</span>
        ) : (
          <span className="small muted">{parts.join(" · ")}</span>
        )}
        {problem && (
          <span className="small state-blocked" role="alert">
            {problem}
          </span>
        )}
      </span>
      {s === "ready" && (
        <button type="button" className="btn btn-sm" onClick={() => openTerminalOn(machine.id)}>
          Open a terminal
        </button>
      )}
      {(s === "unreachable" || s === "failed") && (
        <button type="button" className="btn btn-sm" onClick={retry}>
          Try again
        </button>
      )}
      {s !== "updating" && s !== "adding" && (
        <button type="button" className="btn btn-sm" onClick={onRemove}>
          Remove…
        </button>
      )}
      {s === "ready" && <SignInOn machine={machine.id} name={machine.name} native={native} boxed={false} />}
    </li>
  );
}

/** Settings → Machines: this computer and the person's own Linux machines,
 *  where each stands, and adding one. */
export function Machines({ native = realNative }: { native?: MachineNative }) {
  const machines = useMachines((s) => s.machines);
  const local = useDesk((s) => sessionsOn(s.sessions, LOCAL).length);
  const platform = useHost((h) => h.platform);
  const version = useDeskVersion();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Machine | null>(null);
  return (
    <section className="settings-pane" aria-label="Machines">
      <div className="machines-head">
        <h1 className="display-lg">Machines</h1>
        <button type="button" className="btn btn-signal" onClick={() => setAdding(true)}>
          Add machine
        </button>
      </div>
      <p className="muted">
        Run sessions on your own Linux servers. Each runs Desk in the background, so its sessions keep going when {thisComputerLower(platform)} sleeps.
      </p>
      <ul className="machine-list" aria-label="Machines">
        <li className="machine-row" aria-label={thisComputer(platform)}>
          <span className="dot dot-done" aria-hidden="true" />
          <span className="machine-row-text">
            <b>{thisComputer(platform)}</b>
            <span className="small muted">{[sessionsText(local), version && `Desk ${version}`].filter(Boolean).join(" · ")}</span>
          </span>
        </li>
        {machines.map((m) => (
          <MachineRow key={m.id} machine={m} version={version} native={native} onRemove={() => setRemoving(m)} />
        ))}
      </ul>
      {adding && <AddMachine native={native} onClose={() => setAdding(false)} />}
      {removing && (
        <Confirm title={`Remove ${removing.name}?`} action="Remove" onConfirm={() => native.remove(removing.id)} onClose={() => setRemoving(null)}>
          <p>
            Desk on {thisComputerLower(platform)} forgets {removing.name}. Desk keeps running there, with its sessions, until you stop it. To take it off{" "}
            {removing.name} too, run these there:
          </p>
          <code className="mono small machine-key">systemctl --user disable --now desk-helper</code>
          <code className="mono small machine-key">~/.local/share/Desk/bin/current/desk-helper --remove-everything</code>
        </Confirm>
      )}
    </section>
  );
}
