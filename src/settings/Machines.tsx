import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { useDesk } from "../hub/store";
import { AddMachine } from "../machines/AddMachine";
import { LOCAL, sessionsOn, useMachines, type Machine, type MachineId } from "../machines/engines";
import { native as realNative, type MachineNative } from "../machines/native";
import { OpenTerminal } from "../machines/OpenTerminal";
import { UpdateSteps } from "../machines/UpdateSteps";
import { useUpdates } from "../updates/store";
import { plainError } from "../ui/plainError";
import { useEngineSummary } from "../machines/summary";
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

/** "Check for updates": a machine on a newer Desk is driven again once
 *  this Desk updates to it. */
export function CheckForUpdates() {
  const phase = useUpdates((s) => s.state.phase);
  const [said, setSaid] = useState<string | null>(null);
  const check = async () => {
    setSaid(null);
    try {
      await useUpdates.getState().check({ asked: true });
      if (useUpdates.getState().state.phase === "idle") setSaid("This Desk is up to date for now.");
    } catch (e) {
      setSaid(plainError(e));
    }
  };
  if (phase !== "idle") return <span className="small muted">Desk is updating: see the notice.</span>;
  return (
    <>
      {said && <span className="small muted">{said}</span>}
      <button type="button" className="btn btn-sm" onClick={() => void check()}>
        Check for updates
      </button>
    </>
  );
}

/** The version last told about, so "Desk is now …" says so once. */
const SEEN_KEY = "desk.machines.version-seen";
const seenVersion = (): string | null => {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
};

/** "Desk is now 0.2.1": once after Desk updates, what its machines do
 *  about it (they update to match when they connect). */
function UpdatedBanner({ version, machines }: { version: string | null; machines: Machine[] }) {
  const [seen, setSeen] = useState(seenVersion);
  if (!version || machines.length === 0) return null;
  if (seen === null) {
    // The first time: nothing to say; this version is the one known.
    try {
      localStorage.setItem(SEEN_KEY, version);
    } catch {
      /* said every time, then */
    }
    return null;
  }
  if (seen === version) return null;
  const updating = machines.filter((m) => m.state.kind === "updating").map((m) => m.name);
  const failed = machines.filter((m) => m.state.kind === "updateFailed").map((m) => m.name);
  const parts = [updating.length > 0 && `${updating.join(", ")} ${updating.length === 1 ? "is" : "are"} updating now`, failed.length > 0 && `${failed.join(", ")} couldn’t`].filter(Boolean);
  return (
    <div className="setting-card machines-banner" role="status">
      <span className="prov-text">
        <b>Desk is now {version}</b>
        <span>Machines update to match when they connect{parts.length ? `: ${parts.join(", ")}` : "."}</span>
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => {
          try {
            localStorage.setItem(SEEN_KEY, version);
          } catch {
            /* shown again next time */
          }
          setSeen(version);
        }}
      >
        OK
      </button>
    </div>
  );
}

/** What a machine's row offers for where it stands, besides opening it. */
function RowActions({
  machine,
  native,
  claudeIn,
  onOpen,
  onNewSession,
  onTerminal,
}: {
  machine: Machine;
  native: MachineNative;
  claudeIn: boolean | null;
  onOpen: (at?: "engines" | "log") => void;
  onNewSession: () => void;
  onTerminal: () => void;
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
          <button type="button" className="btn btn-sm" onClick={onTerminal}>
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
      {s === "updateFailed" && (
        <button type="button" className="btn btn-sm btn-signal" onClick={reconnect}>
          Update to match
        </button>
      )}
      {(s === "unreachable" || s === "updateFailed" || (s === "failed" && !keyChanged(machine))) && (
        <button type="button" className="btn btn-sm" onClick={() => onOpen("log")}>
          View log
        </button>
      )}
      {s === "newer" && <CheckForUpdates />}
      {/* Being set up after "Do this later": its progress, and stopping it. */}
      {s === "adding" && (
        <>
          <button type="button" className="btn btn-sm" onClick={() => onOpen("log")}>
            Show progress
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setProblem(null);
              native.cancelAdd(machine.id).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
            }}
          >
            Cancel adding
          </button>
        </>
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
  onTerminal,
}: {
  machine: Machine;
  version: string | null;
  native: MachineNative;
  onOpen: (at?: "engines" | "log") => void;
  onNewSession: () => void;
  onTerminal: () => void;
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
      {/* Beside its name, not the middle of its steps, while it updates. */}
      <span className={`dot dot-${look}${machine.state.kind === "updating" ? " dot-top" : ""}`} aria-hidden="true" />
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
        {machine.state.kind === "updating" && <UpdateSteps machine={machine} native={native} />}
      </span>
      <RowActions machine={machine} native={native} claudeIn={summary.claudeIn} onOpen={onOpen} onNewSession={onNewSession} onTerminal={onTerminal} />
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
  const [terminal, setTerminal] = useState<Machine | null>(null);
  const shown = open && machines.find((m) => m.id === open.id);
  const terminalDialog = terminal && <OpenTerminal machine={terminal.id} name={terminal.name} native={native} onClose={() => setTerminal(null)} />;
  if (shown)
    return (
      <>
        <MachineDetail
          machine={shown}
          version={version}
          native={native}
          at={open.at}
          onBack={() => setOpen(null)}
          onNewSession={() => setStarting(shown.id)}
          onTerminal={() => setTerminal(shown)}
        />
        {starting && <NewSession on={starting} onClose={() => setStarting(null)} />}
        {terminalDialog}
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
      <UpdatedBanner version={version} machines={machines} />
      <ul className="machine-list" aria-label="Machines">
        <li className="machine-row" aria-label={thisComputer(platform)}>
          <span className="dot dot-done" aria-hidden="true" />
          <span className="machine-row-text">
            <b>{thisComputer(platform)}</b>
            <span className="small muted">{[sessionsCount(local), version && `Desk ${version}`].filter(Boolean).join(" · ")}</span>
          </span>
        </li>
        {machines.map((m) => (
          <MachineRow
            key={m.id}
            machine={m}
            version={version}
            native={native}
            onOpen={(at) => setOpen({ id: m.id, at })}
            onNewSession={() => setStarting(m.id)}
            onTerminal={() => setTerminal(m)}
          />
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
      {terminalDialog}
    </section>
  );
}
