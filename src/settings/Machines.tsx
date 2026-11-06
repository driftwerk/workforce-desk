import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { useDesk } from "../hub/store";
import { AddMachine } from "../machines/AddMachine";
import { LOCAL, sessionsOn, useMachines, type Machine, type MachineId } from "../machines/engines";
import { native as realNative, type MachineNative } from "../machines/native";
import { useEngineSummary } from "../machines/summary";
import { openTerminalOn } from "../machines/watch";
import { dotOf, forgetKeyLine, keyChanged, rowLines, sessionsCount, thisComputer, thisComputerLower, twinNote } from "../machines/words";
import { shortPrint } from "./EditReach";
import { inApp } from "../platform";
import { NewSession } from "../session/NewSession";
import { useHost } from "../shell/host";
import { CopyButton } from "./EngineBlocks";
import { MachineDetail } from "./MachineDetail";

/** This Desk's version; null outside the app or until it's read (`given`
 *  stands in for it in a preview). */
export const useDeskVersion = (given: string | null = null): string | null => {
  const [version, setVersion] = useState<string | null>(given);
  useEffect(() => {
    if (inApp) void getVersion().then(setVersion).catch(() => undefined);
  }, []);
  return version;
};

/** Now, again every second while something on screen counts down. */
export const useNow = (ticking: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  return now;
};

/** What a machine's row offers for where it stands, besides opening it. */
function RowActions({
  machine,
  native,
  claudeIn,
  onOpen,
  onNewSession,
}: {
  machine: Machine;
  native: MachineNative;
  claudeIn: boolean | null;
  onOpen: (at?: "engines" | "log") => void;
  onNewSession: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const s = machine.state.kind;
  const reconnect = () => {
    setProblem(null);
    native.reconnect(machine.id).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
  return (
    <span className="machine-row-actions">
      {problem && (
        <span className="small state-blocked" role="alert">
          {problem}
        </span>
      )}
      {s === "ready" && claudeIn === false && (
        <button type="button" className="btn btn-sm btn-signal" onClick={() => onOpen("engines")}>
          Sign in…
        </button>
      )}
      {s === "ready" && claudeIn !== false && (
        <>
          <button type="button" className="btn btn-sm" onClick={() => openTerminalOn(machine.id)}>
            Open a terminal…
          </button>
          <button type="button" className="btn btn-sm" onClick={onNewSession}>
            New session…
          </button>
        </>
      )}
      {(s === "unreachable" || s === "failed") && (
        <button type="button" className="btn btn-sm" onClick={reconnect}>
          Reconnect
        </button>
      )}
      {(s === "unreachable" || (s === "failed" && !keyChanged(machine))) && (
        <button type="button" className="btn btn-sm" onClick={() => onOpen("log")}>
          View log
        </button>
      )}
    </span>
  );
}

/** One machine in the list: where it stands and why, in its own words where
 *  Desk has them, with its way out on the row; open it for the rest. */
function MachineRow({
  machine,
  version,
  native,
  onOpen,
  onNewSession,
}: {
  machine: Machine;
  version: string | null;
  native: MachineNative;
  onOpen: (at?: "engines" | "log") => void;
  onNewSession: () => void;
}) {
  const count = useDesk((s) => sessionsOn(s.sessions, machine.id).length);
  const all = useMachines((s) => s.machines);
  const ready = machine.state.kind === "ready";
  const summary = useEngineSummary(machine.id, ready);
  const now = useNow(!!machine.nextTry);
  const lines = rowLines(machine, { desk: version, sessions: count, now, claudeIn: summary.claudeIn, signedIn: summary.line, twin: twinNote(machine, all) });
  const blocked = lines.tone === "blocked";
  const look = ready && summary.claudeIn === false ? "blocked" : dotOf(machine.state);
  const changed = keyChanged(machine);
  return (
    <li className="machine-row" aria-label={machine.name}>
      <span className={`dot dot-${look}`} aria-hidden="true" />
      <span className="machine-row-text">
        <span className="machine-row-name">
          <b>{machine.name}</b>
          {machine.target && machine.target !== machine.name && <span className="mono small muted">{machine.target}</span>}
          {machine.reach?.via && <span className="chip">via {machine.reach.via}</span>}
        </span>
        <span className={`small ${blocked ? "state-blocked" : "muted"}`}>
          {changed
            ? `${machine.name} shows a different host key from the one this computer knows, so Desk won’t connect. If it was reinstalled, remove its old key, then Reconnect:`
            : lines.first}
        </span>
        {changed && (
          <>
            {(machine.shownKey || machine.hostKey) && (
              <span className="small faint mono">
                {[machine.shownKey && `shows ${shortPrint(machine.shownKey.fingerprint)}`, machine.hostKey && `Desk knew ${shortPrint(machine.hostKey.fingerprint)}`].filter(Boolean).join(" · ")}
              </span>
            )}
            <span className="machine-line">
              <code className="mono small">{forgetKeyLine(machine)}</code>
              <CopyButton text={forgetKeyLine(machine)} />
            </span>
          </>
        )}
        {lines.second && <span className="small faint">{lines.second}</span>}
      </span>
      <RowActions machine={machine} native={native} claudeIn={summary.claudeIn} onOpen={onOpen} onNewSession={onNewSession} />
      <button type="button" className="machine-row-open" aria-label={`Open ${machine.name}`} onClick={() => onOpen()}>
        ›
      </button>
    </li>
  );
}

/** Settings → Machines: this computer and the person's own Linux machines,
 *  where each stands and why, adding one, and each one's own page. */
export function Machines({ native = realNative, deskVersion = null }: { native?: MachineNative; deskVersion?: string | null }) {
  const machines = useMachines((s) => s.machines);
  const local = useDesk((s) => sessionsOn(s.sessions, LOCAL).length);
  const platform = useHost((h) => h.platform);
  const version = useDeskVersion(deskVersion);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<{ id: MachineId; at?: "engines" | "log" } | null>(null);
  const [starting, setStarting] = useState<MachineId | null>(null);
  const shown = open && machines.find((m) => m.id === open.id);
  if (shown)
    return (
      <>
        <MachineDetail machine={shown} version={version} native={native} at={open.at} onBack={() => setOpen(null)} onNewSession={() => setStarting(shown.id)} />
        {starting && <NewSession on={starting} onClose={() => setStarting(null)} />}
      </>
    );
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
            <span className="small muted">{[sessionsCount(local), version && `Desk ${version}`].filter(Boolean).join(" · ")}</span>
          </span>
        </li>
        {machines.map((m) => (
          <MachineRow key={m.id} machine={m} version={version} native={native} onOpen={(at) => setOpen({ id: m.id, at })} onNewSession={() => setStarting(m.id)} />
        ))}
      </ul>
      {machines.length > 0 && (
        <p className="small faint">
          Open a machine to change how Desk reaches it, sign in there, update it, read its log or remove it. Machines update to this Desk’s version by themselves when
          they connect.
        </p>
      )}
      {adding && <AddMachine native={native} onClose={() => setAdding(false)} />}
      {starting && <NewSession on={starting} onClose={() => setStarting(null)} />}
    </section>
  );
}
