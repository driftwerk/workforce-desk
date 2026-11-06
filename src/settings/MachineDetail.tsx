import { useCallback, useEffect, useRef, useState } from "react";
import { forgetMachine } from "../groups/machines";
import { AddMachine } from "../machines/AddMachine";
import { useDesk } from "../hub/store";
import { sessionsOn, type Machine } from "../machines/engines";
import type { LogLine, MachineNative } from "../machines/native";
import { openTerminalOn } from "../machines/watch";
import { clock, dotOf, freeText, inTime, keyChanged, offlineWhy, sessionsCount, thisComputer, thisComputerLower } from "../machines/words";
import { useHost } from "../shell/host";
import { Confirm } from "../ui/Confirm";
import { plainError } from "../ui/plainError";
import { CopyButton, EngineBlocks } from "./EngineBlocks";
import { EditReach } from "./EditReach";
import { useNow } from "./Machines";

/** How often Desk looks at a ready machine's link (fleet `check_every`). */
const CHECKS_EVERY_S = 5;

/** A section of the page: its label, what's at its right, and its body. */
function Section({ title, right, children, id }: { title: string; right?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section className="prov-section machine-section" aria-label={title} id={id}>
      <div className="machine-section-head">
        <span className="ov-label muted">{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

/** One row of a section's list. */
function Row({ title, children, tone }: { title: string; children?: React.ReactNode; tone?: "done" | "blocked" }) {
  return (
    <div className="prov-row">
      <span className="prov-text">
        <b>{title}</b>
        {children && <span className={tone === "done" ? "state-on" : tone === "blocked" ? "state-blocked" : undefined}>{children}</span>}
      </span>
    </div>
  );
}

/** The machine's log: this computer's of it, or Desk's own there. */
export function MachineLog({ machine, native, here }: { machine: Machine; native: MachineNative; here: string }) {
  const [which, setWhich] = useState<"here" | "there">("here");
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [there, setThere] = useState<{ text: string } | { problem: string } | "reading" | null>(null);
  const ready = machine.state.kind === "ready";
  const readHere = useCallback(() => {
    native
      .log(machine.id)
      .then(setLines)
      .catch(() => setLines([]));
  }, [native, machine.id]);
  // Read again whenever it changes state or tries again.
  useEffect(readHere, [readHere, machine.state.kind, machine.lastTry, machine.nextTry]);
  const readThere = useCallback(() => {
    setThere("reading");
    native
      .remoteLog(machine.id)
      .then((text) => setThere({ text }))
      .catch((e: unknown) => setThere({ problem: plainError(e) }));
  }, [native, machine.id]);
  useEffect(() => {
    if (which === "there" && ready) readThere();
  }, [which, ready, readThere]);
  const text =
    which === "here"
      ? (lines ?? []).map((l) => `${clock(l.at)}  ${l.text}`).join("\n")
      : there && typeof there === "object" && "text" in there
        ? there.text
        : "";
  return (
    <Section
      title="Recent log"
      id="machine-log"
      right={
        <span className="machine-log-tools">
          <button type="button" className="btn btn-sm" disabled={!text} onClick={() => void navigator.clipboard?.writeText(text)}>
            Copy
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void native.revealLog().catch(() => undefined)}>
            Show in Finder
          </button>
        </span>
      }
    >
      <div className="seg machine-log-seg" role="radiogroup" aria-label="Which log">
        <button type="button" role="radio" aria-checked={which === "here"} onClick={() => setWhich("here")}>
          {here[0]!.toUpperCase() + here.slice(1)}’s connection log
        </button>
        <button type="button" role="radio" aria-checked={which === "there"} onClick={() => setWhich("there")}>
          Desk on {machine.name}
        </button>
      </div>
      <div className="machine-log" role="log" aria-label={which === "here" ? `${here}’s connection log` : `Desk’s log on ${machine.name}`}>
        {which === "here" &&
          (lines === null ? (
            <span className="faint">Reading…</span>
          ) : lines.length === 0 ? (
            <span className="faint">Nothing yet.</span>
          ) : (
            lines.map((l, i) => (
              <div key={i} className="machine-log-line">
                <span className="faint">{clock(l.at)}</span>
                <span className={`machine-log-${l.kind}`}>{l.text}</span>
              </div>
            ))
          ))}
        {which === "there" &&
          (!ready ? (
            <span className="faint">Desk on {machine.name}’s own log (its service, last 200 lines) shows here once Desk reaches it.</span>
          ) : there === "reading" || there === null ? (
            <span className="faint">Reading it over SSH… Desk gives up after 10 s.</span>
          ) : "problem" in there ? (
            <span className="state-blocked">
              {there.problem}{" "}
              <button type="button" className="link small" onClick={readThere}>
                Try again
              </button>
            </span>
          ) : (
            <pre className="machine-log-pre">{there.text}</pre>
          ))}
      </div>
      {which === "here" && <span className="small faint">Desk on {machine.name}’s own log (its service, last 200 lines) is under Desk on {machine.name}.</span>}
    </Section>
  );
}

/** The status card: connected, or why not, with ssh's own words and when. */
function Status({ machine, native, here, sessions, onLog }: { machine: Machine; native: MachineNative; here: string; sessions: number; onLog: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const now = useNow(!!machine.nextTry);
  const reconnect = () => {
    setProblem(null);
    native.reconnect(machine.id).catch((e: unknown) => setProblem(plainError(e)));
  };
  const s = machine.state.kind;
  if (s === "ready")
    return (
      <div className="setting-card machine-status" role="status">
        <span className="prov-text">
          <b className="state-done">Connected</b>
          <span>
            {[sessionsCount(sessions), machine.connectedSince && `connected since ${clock(machine.connectedSince, now)}`, `Desk checks the link every ${CHECKS_EVERY_S} s`]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={reconnect}>
          Reconnect
        </button>
        <button type="button" className="btn btn-sm" onClick={onLog}>
          View log
        </button>
      </div>
    );
  if (s === "unreachable" || s === "failed") {
    const title = s === "unreachable" ? "Offline" : keyChanged(machine) ? "Its host key has changed" : "Not working";
    const why = s === "unreachable" ? offlineWhy(machine).split(". ")[0]!.replace(/\.$/, "") : machine.state.kind === "failed" ? machine.state.message : "";
    return (
      <div className="setting-card machine-status machine-status-problem" role="status">
        <b className="state-blocked">{title}</b>
        <span>{machine.said ? `${why}:` : why}</span>
        {machine.said && <code className="machine-said mono small">{machine.said}</code>}
        <span className="small faint">
          {[
            machine.lastConnected && `Last connected ${clock(machine.lastConnected, now)}`,
            machine.lastTry && `tried at ${clock(machine.lastTry, now)} and gave up after 15 s`,
            machine.nextTry && `next try ${inTime(machine.nextTry, now)}, then less often, up to every 5 minutes`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {sessions > 0 && (
          <span className="small">
            Its {sessionsCount(sessions)} keep running on {machine.name}. Desk shows them again when it reconnects.
          </span>
        )}
        {problem && (
          <span className="small state-blocked" role="alert">
            {problem}
          </span>
        )}
        <span className="machine-actions">
          <button type="button" className="btn btn-sm btn-signal" onClick={reconnect}>
            Reconnect now
          </button>
          <button type="button" className="btn btn-sm" onClick={onLog}>
            View log
          </button>
          <span className="small faint">
            If <span className="mono">ssh {machine.reach?.entry ?? machine.target}</span> works in a terminal on {here}, Reconnect now.
          </span>
        </span>
      </div>
    );
  }
  const busy = s === "connecting" ? "Connecting… Desk gives up after 15 s and says why." : s === "adding" ? "Being set up…" : s === "updating" ? "Updating Desk there… its sessions carry on." : `It runs a newer Desk (${machine.version}). Update Desk here to drive it; its sessions keep running.`;
  return (
    <div className="setting-card machine-status" role="status">
      <span className="prov-text">
        <b>{s === "newer" ? "On a newer Desk" : s === "connecting" ? "Connecting" : s === "adding" ? "Being set up" : "Updating"}</b>
        <span>{busy}</span>
      </span>
    </div>
  );
}

/** A machine's own page: where it stands and why, how Desk reaches it (and
 *  changing that), Desk there, its engines and sign-ins, its log, and
 *  removing it. */
export function MachineDetail({
  machine,
  version,
  native,
  at,
  onBack,
  onNewSession,
}: {
  machine: Machine;
  version: string | null;
  native: MachineNative;
  at?: "engines" | "log";
  onBack: () => void;
  onNewSession: () => void;
}) {
  const platform = useHost((h) => h.platform);
  const here = thisComputerLower(platform);
  const sessions = useDesk((s) => sessionsOn(s.sessions, machine.id).length);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [addingNew, setAddingNew] = useState<string | null>(null);
  const top = useRef<HTMLElement>(null);
  const ready = machine.state.kind === "ready";
  const toLog = () => document.getElementById("machine-log")?.scrollIntoView({ block: "start" });
  useEffect(() => {
    if (at) document.getElementById(at === "log" ? "machine-log" : "machine-engines")?.scrollIntoView({ block: "start" });
  }, [at]);
  const r = machine.reach;
  const how = r?.via ? `through ${r.via}` : "directly";
  const key = machine.hostKey;
  const same = version && machine.version && machine.version === version;
  const d = machine.details;
  return (
    <section className="settings-pane machine-page" aria-label={machine.name} ref={top}>
      <button type="button" className="link small machine-back" onClick={onBack}>
        ‹ Machines
      </button>
      <div className="machine-head">
        <span className={`dot dot-${dotOf(machine.state)}`} aria-hidden="true" />
        <h1 className="display-lg">{machine.name}</h1>
        <span className="chip">{machine.target}</span>
        {r?.via && <span className="chip">via {r.via}</span>}
        <span className="machine-head-actions">
          <button type="button" className="btn" disabled={!ready} onClick={() => openTerminalOn(machine.id)}>
            Open a terminal…
          </button>
          <button type="button" className="btn btn-signal" disabled={!ready} onClick={onNewSession}>
            New session…
          </button>
        </span>
      </div>

      <Status machine={machine} native={native} here={here} sessions={sessions} onLog={toLog} />

      <Section
        title="How Desk reaches it"
        right={
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
            Change…
          </button>
        }
      >
        <div className="prov-list">
          {r?.entry ? (
            <Row title="SSH config entry">
              <span className="mono">{r.entry}</span> from {r.file ?? "~/.ssh/config"}
            </Row>
          ) : (
            <Row title="Address">
              <span className="mono">{machine.target}</span>
            </Row>
          )}
          {r && (
            <Row title="Connects as">
              {[`${r.user ?? "you"}@${r.hostname ?? machine.target}`, r.port && `port ${r.port}`, how].filter(Boolean).join(", ")}
            </Row>
          )}
          {r?.via && (
            <Row title="Jump host">
              {r.via}
              {r.via === "a ProxyCommand" ? "" : " (ProxyJump)"}, as your SSH config says. Desk goes through it as a terminal would, and doesn’t change it here.
            </Row>
          )}
          <Row title="Host key">
            {key
              ? `${key.kind} · ${key.fingerprint.length > 20 ? `${key.fingerprint.slice(0, 11)}…${key.fingerprint.slice(-4)}` : key.fingerprint} · ${key.trustedAt ? `trusted from Desk on ${new Date(key.trustedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "in your known_hosts"}`
              : "Read when Desk next connects."}
          </Row>
        </div>
      </Section>

      <Section title={`Desk on ${machine.name}`}>
        <div className="prov-list">
          <Row title={machine.version ? `Desk ${machine.version}` : "Desk"} tone={same ? "done" : machine.state.kind === "newer" ? "blocked" : undefined}>
            {same ? `The same as ${here}` : machine.state.kind === "newer" ? `Newer than ${here}’s ${version ?? ""}` : version ? `${thisComputer(platform)} runs ${version}: it updates when it connects` : null}
          </Row>
          {machine.system && (
            <Row title={`Linux ${machine.system.arch}`}>
              {[machine.system.os, machine.system.glibc && `glibc ${machine.system.glibc}`, d?.freeKb != null && `${freeText(d.freeKb)} free`].filter(Boolean).join(" · ")}
            </Row>
          )}
          {d && (
            <Row title={d.service && d.linger ? `Starts when ${machine.name} boots` : `Starts when Desk connects`}>
              {d.service && d.linger
                ? `Its own user service, kept on with linger, so sessions carry on while ${here} sleeps.`
                : d.systemd
                  ? `Desk starts itself there each time it connects. To start it when ${machine.name} boots, run this there once:`
                  : `${machine.name} has no systemd for its users, so Desk starts itself there each time it connects.`}
            </Row>
          )}
        </div>
        {d && !(d.service && d.linger) && d.systemd && (
          <span className="machine-line">
            <code className="mono small">sudo loginctl enable-linger {d.user ?? r?.user ?? ""}</code>
            <CopyButton text={`sudo loginctl enable-linger ${d.user ?? r?.user ?? ""}`} />
          </span>
        )}
      </Section>

      {ready && (
        <Section title={`Engines on ${machine.name}`} id="machine-engines" right={<span className="small faint">Also in Settings → Engines, with {machine.name} chosen</span>}>
          <EngineBlocks machine={machine.id} name={machine.name} native={native} />
        </Section>
      )}

      <MachineLog machine={machine} native={native} here={here} />

      <Section title="Remove">
        <div className="setting-card">
          <span className="prov-text">
            <b>Remove {machine.name} from Desk</b>
            <span>Desk on {here} forgets it. Desk keeps running there, with its sessions, until you stop it.</span>
          </span>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => setRemoving(true)}>
            Remove…
          </button>
        </div>
      </Section>

      {editing && (
        <EditReach
          machine={machine}
          native={native}
          onClose={() => setEditing(false)}
          onAddNew={(target) => {
            setEditing(false);
            setAddingNew(target);
          }}
        />
      )}
      {addingNew && <AddMachine native={native} target={addingNew} onClose={() => setAddingNew(null)} />}
      {removing && (
        <Confirm
          title={`Remove ${machine.name}?`}
          action="Remove"
          onConfirm={() =>
            native.remove(machine.id).then(() => {
              forgetMachine(machine.id, true);
              onBack();
            })
          }
          onClose={() => setRemoving(false)}
        >
          <p>
            Desk on {here} forgets {machine.name}. Desk keeps running there, with its sessions, until you stop it. To take it off {machine.name} too, run these there:
          </p>
          <code className="mono small machine-key">systemctl --user disable --now desk-helper</code>
          <code className="mono small machine-key">~/.local/share/Desk/bin/current/desk-helper --remove-everything</code>
        </Confirm>
      )}
    </section>
  );
}
