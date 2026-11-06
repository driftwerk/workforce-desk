import { useEffect, useId, useState } from "react";
import type { Machine } from "../machines/engines";
import type { Edited, HostEntry, MachineNative } from "../machines/native";
import { thisComputerLower } from "../machines/words";
import { useHost } from "../shell/host";
import { plainError } from "../ui/plainError";

/** Where an SSH config entry goes, as the list shows it: `dev@2.29.244.190`. */
const whereOf = (e: HostEntry): string => [e.user && `${e.user}@`, e.hostname ?? e.host, e.port && e.port !== "22" ? `:${e.port}` : ""].filter(Boolean).join("");

/** A fingerprint shortened as Desk shows it: `SHA256:k3Vq…9fXc`. */
export const shortPrint = (f: string): string => (f.length > 20 ? `${f.slice(0, 11)}…${f.slice(-4)}` : f);

/** "Change how Desk reaches devbox": another SSH config entry, or a typed
 *  user, address and port, and its name. A new address is used only once
 *  the person says yes natively and it shows the machine's own host key;
 *  another key is refused, with adding it as a new machine instead. Its
 *  sessions, sign-ins and settings stay. */
export function EditReach({
  machine,
  native,
  onClose,
  onAddNew,
}: {
  machine: Machine;
  native: MachineNative;
  onClose: () => void;
  /** Adds the address as a machine of its own. */
  onAddNew?: (target: string) => void;
}) {
  const platform = useHost((h) => h.platform);
  const [tab, setTab] = useState<"config" | "address">(machine.reach?.entry ? "config" : "address");
  const [hosts, setHosts] = useState<HostEntry[] | null>(null);
  const [picked, setPicked] = useState<string | null>(machine.reach?.entry ?? null);
  const at = machine.target.lastIndexOf("@");
  const [user, setUser] = useState(at >= 0 ? machine.target.slice(0, at) : (machine.reach?.user ?? ""));
  const [address, setAddress] = useState(at >= 0 ? machine.target.slice(at + 1) : machine.reach?.entry ? (machine.reach.hostname ?? "") : machine.target);
  const [port, setPort] = useState("22");
  const [name, setName] = useState(machine.name);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ kind: "problem"; text: string } | { kind: "different"; result: Extract<Edited, { kind: "differentKey" }>; target: string } | null>(null);
  const ids = { user: useId(), address: useId(), port: useId(), name: useId() };

  const read = () => {
    native
      .sshHosts()
      .then(setHosts)
      .catch(() => setHosts([]));
  };
  useEffect(read, [native]);

  const entry = hosts?.find((h) => h.host === picked) ?? null;
  const typed = address.trim() ? `${user.trim() ? `${user.trim()}@` : ""}${address.trim()}` : "";
  const target = tab === "config" ? (picked ?? "") : typed;
  const portProblem = tab === "address" && port.trim() !== "" && port.trim() !== "22" ? "A port other than 22 needs a Host entry in your SSH config, with its Port: pick it under From your SSH config." : null;
  const moving = !!target && target !== machine.target;
  const renaming = name.trim() !== "" && name.trim() !== machine.name;
  const canGo = !busy && !portProblem && (moving || renaming) && name.trim() !== "";

  const go = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const r = await native.edit(machine.id, { ...(moving ? { target } : {}), ...(renaming ? { name: name.trim() } : {}) });
      if (r.kind === "done") return onClose();
      if (r.kind === "differentKey") setSaid({ kind: "different", result: r, target });
    } catch (e) {
      setSaid({ kind: "problem", text: plainError(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="sheet machine-add" role="dialog" aria-label={`Change how Desk reaches ${machine.name}`} onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
        <h2 className="display-md">Change how Desk reaches {machine.name}</h2>
        <p className="muted">Its sessions, sign-ins and settings stay. Desk checks the new way reaches the same machine before it switches.</p>
        <div className="seg seg-on-raised" role="radiogroup" aria-label="How">
          <button type="button" role="radio" aria-checked={tab === "config"} onClick={() => setTab("config")}>
            From your SSH config
          </button>
          <button type="button" role="radio" aria-checked={tab === "address"} onClick={() => setTab("address")}>
            An address
          </button>
        </div>

        {tab === "config" &&
          (hosts === null ? (
            <p className="small faint">Reading your SSH config…</p>
          ) : hosts.length === 0 ? (
            <p className="small faint">Your SSH config has no Host entries Desk can list. Add one there, then Read it again, or type an address.</p>
          ) : (
            <div className="pick-list" role="radiogroup" aria-label="SSH config entries">
              {hosts.map((h) => (
                <button key={h.host} type="button" role="radio" aria-checked={picked === h.host} className="pick-row" onClick={() => setPicked(h.host)}>
                  <span className="pick-ring" aria-hidden="true" />
                  <span className="pick-text">
                    <b className="mono">{h.host}</b>
                    <span className="mono muted">{whereOf(h)}</span>
                  </span>
                  {h.host === machine.reach?.entry || h.host === machine.target ? <span className="small faint">in use now</span> : null}
                  {h.jump && <span className="chip">via {h.jump}</span>}
                </button>
              ))}
            </div>
          ))}
        {tab === "config" && entry && (
          <div className="machine-box" role="group" aria-label="From your SSH config">
            <span className="ov-label muted">From your SSH config</span>
            <dl className="config-grid">
              <dt>HostName</dt>
              <dd>{entry.hostname ?? entry.host}</dd>
              <dt>User</dt>
              <dd>{entry.user ?? "yours on this computer"}</dd>
              <dt>Port</dt>
              <dd>{entry.port ?? "22"}</dd>
              <dt>Jump host</dt>
              <dd>{entry.jump ?? "none"}</dd>
            </dl>
            <span className="small faint">
              Desk only reads your SSH config ({entry.file}). Edit it there; Desk reads it again when you come back.{" "}
              <button type="button" className="link small" onClick={read}>
                Read it again
              </button>
            </span>
          </div>
        )}

        {tab === "address" && (
          <div className="reach-fields">
            <div className="field">
              <label htmlFor={ids.user} className="ov-label muted">
                User
              </label>
              <input id={ids.user} className="field-text mono" value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} autoCapitalize="off" />
            </div>
            <div className="field">
              <label htmlFor={ids.address} className="ov-label muted">
                Address
              </label>
              <input id={ids.address} className="field-text mono" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} autoCapitalize="off" autoFocus />
            </div>
            <div className="field">
              <label htmlFor={ids.port} className="ov-label muted">
                Port
              </label>
              <input id={ids.port} className="field-text mono" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
            </div>
          </div>
        )}
        {portProblem && <p className="small state-blocked">{portProblem}</p>}

        <div className="field">
          <label htmlFor={ids.name} className="ov-label muted">
            Name
          </label>
          <input id={ids.name} className="field-text" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </div>

        {said?.kind === "different" && (
          <div className="machine-box" role="alert" aria-label="Not the same machine">
            <span className="ov-label state-blocked">Not the same machine</span>
            <span>
              {said.target} shows a different host key from {machine.name}’s.
            </span>
            <dl className="config-grid">
              <dt>This address</dt>
              <dd>
                {said.result.shown.kind} {shortPrint(said.result.shown.fingerprint)}
              </dd>
              <dt>{machine.name}</dt>
              <dd>
                {said.result.known.kind} {shortPrint(said.result.known.fingerprint)}
              </dd>
            </dl>
            <span className="small muted">
              Desk won’t move {machine.name} to a machine with another key. If {machine.name} was reinstalled, its sessions are gone with it: add it as a new machine.
            </span>
            <span className="machine-actions">
              {onAddNew && (
                <button type="button" className="btn btn-sm" onClick={() => onAddNew(said.target)}>
                  Add {said.target} as a new machine…
                </button>
              )}
              <button type="button" className="btn btn-sm" onClick={() => setSaid(null)}>
                Back
              </button>
            </span>
          </div>
        )}
        {said?.kind === "problem" && (
          <p className="small state-blocked" role="alert">
            {said.text}
          </p>
        )}
        {busy && moving && <p className="small muted">Checking {target} shows {machine.name}’s host key… Desk gives up after 15 s and says why.</p>}
        {moving && !said && !busy && (
          <p className="small faint">Switching asks you once, in a {platform === "macos" ? "macOS" : "system"} dialog, then Desk checks it is the same machine before it trusts the new address on {thisComputerLower(platform)}.</p>
        )}

        <footer className="sheet-foot">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-signal" disabled={!canGo} onClick={() => void go()}>
            {moving ? (tab === "config" && picked ? `Check and switch to ${picked}` : "Check and switch") : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
