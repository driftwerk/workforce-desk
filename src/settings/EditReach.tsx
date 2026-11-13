import { useEffect, useId, useRef, useState } from "react";
import type { Machine } from "../machines/engines";
import type { Checked, HostEntry, MachineNative } from "../machines/native";
import { forwardsRefused, isDesks, thisComputerLower } from "../machines/words";
import { useHost } from "../shell/host";
import { plainError } from "../ui/plainError";

/** Where an SSH config entry goes, as the list shows it: `dev@2.29.244.190`. */
const whereOf = (e: HostEntry): string => [e.user && `${e.user}@`, e.hostname ?? e.host, e.port && e.port !== "22" ? `:${e.port}` : ""].filter(Boolean).join("");

/** A fingerprint shortened as Desk shows it: `SHA256:k3Vq…9fXc`. */
export const shortPrint = (f: string): string => (f.length > 20 ? `${f.slice(0, 11)}…${f.slice(-4)}` : f);

/** How long Desk waits on ssh while checking an address (fleet `edit_within`). */
export const CHECK_WITHIN_S = 45;

/** "Change how Desk reaches devbox": another SSH config entry, or a typed
 *  user, address and port, and its name. A new address is first checked
 *  (once the person says yes natively) to show the machine's own host key:
 *  the same key is said, then switched to with a click; another key is
 *  refused, with adding it as a new machine instead. Its sessions, sign-ins
 *  and settings stay. Cancel always works: a check still running is let go. */
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
  const [busy, setBusy] = useState<false | "checking" | "switching">(false);
  const [said, setSaid] = useState<
    | { kind: "problem"; text: string }
    | { kind: "different"; result: Extract<Checked, { kind: "differentKey" }>; target: string }
    | { kind: "same"; result: Extract<Checked, { kind: "same" }>; target: string }
    | null
  >(null);
  /** Each check or switch, so one let go (Cancel, another) changes nothing. */
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );
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
  // The address alone, as the person reads it: `2.29.244.201`.
  const bare = (t: string) => t.slice(t.lastIndexOf("@") + 1);
  const checked = said?.kind === "same" && said.target === target;
  const refused = said?.kind === "different" && said.target === target;
  const canGo = !busy && !portProblem && (moving || renaming) && name.trim() !== "" && !refused;

  const close = () => {
    run.current++;
    onClose();
  };
  /** Checks the new address: nothing changes yet. */
  const check = async (to: string = target) => {
    const mine = ++run.current;
    setBusy("checking");
    setSaid(null);
    try {
      const r = await native.checkReach(machine.id, to);
      if (run.current !== mine) return;
      if (r.kind === "same") setSaid({ kind: "same", result: r, target: to });
      if (r.kind === "differentKey") setSaid({ kind: "different", result: r, target: to });
    } catch (e) {
      if (run.current === mine) setSaid({ kind: "problem", text: plainError(e) });
    } finally {
      if (run.current === mine) setBusy(false);
    }
  };
  /** "Give Desk its own entry": the same machine without the forwards
   *  the person's entry has, under a name of Desk's (after a native yes),
   *  picked and checked. */
  const giveEntry = async () => {
    const mine = ++run.current;
    setBusy("checking");
    try {
      const alias = await native.deskEntry(target);
      if (run.current !== mine) return;
      setBusy(false);
      if (!alias) return;
      read();
      setTab("config");
      setPicked(alias);
      await check(alias);
    } catch (e) {
      if (run.current === mine) {
        setSaid({ kind: "problem", text: plainError(e) });
        setBusy(false);
      }
    }
  };
  /** Saves the name, and switches to an address checked just now. */
  const save = async () => {
    const mine = ++run.current;
    setBusy("switching");
    try {
      const r = await native.edit(machine.id, { ...(moving ? { target } : {}), ...(renaming ? { name: name.trim() } : {}) });
      if (run.current !== mine) return;
      if (r.kind === "done") return onClose();
      if (r.kind === "differentKey") setSaid({ kind: "different", result: r, target });
    } catch (e) {
      if (run.current === mine) setSaid({ kind: "problem", text: plainError(e) });
    } finally {
      if (run.current === mine) setBusy(false);
    }
  };
  const go = () => void (moving && !checked ? check() : save());
  const label = !moving ? "Save" : checked ? `Switch to ${tab === "config" && picked ? picked : bare(target)}` : tab === "config" && picked ? `Check ${picked}` : "Check this address";

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet machine-add" role="dialog" aria-label={`Change how Desk reaches ${machine.name}`} onKeyDown={(e) => e.key === "Escape" && close()}>
        <h2 className="display-lg">Change how Desk reaches {machine.name}</h2>
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
            <p className="small faint">
              Your SSH config has no Host entries Desk can list.{" "}
              <button type="button" className="btn btn-sm" onClick={() => setTab("address")}>
                Type an address
              </button>
            </p>
          ) : (
            <div className="ssh-picks" role="radiogroup" aria-label="SSH config entries">
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
              {bare(said.target)} shows a different host key from {machine.name}
              ’s.
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
                  Add {bare(said.target)} as a new machine…
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
            {forwardsRefused(said.text) && !isDesks(target) && (
              <>
                {" "}
                <button type="button" className="btn btn-sm btn-signal" disabled={!!busy} onClick={() => void giveEntry()}>
                  Give Desk its own entry
                </button>
              </>
            )}
          </p>
        )}
        {checked && said?.kind === "same" && (
          <div className="machine-checked" role="status">
            <span className="dot dot-done" aria-hidden="true" />
            <span className="machine-check-text">
              <span>
                Same machine: its host key matches {machine.name}’s ({shortPrint(said.result.key.fingerprint)}).
              </span>
              <span className="small muted">
                Checked in {Math.max(1, Math.round(said.result.tookMs / 1000))} s. Desk gives up after {CHECK_WITHIN_S} s and says why.
              </span>
            </span>
          </div>
        )}
        {busy === "checking" && (
          <p className="small muted">
            Checking {bare(target)} shows {machine.name}’s host key… Desk gives up after {CHECK_WITHIN_S} s and says why.
          </p>
        )}
        {moving && !said && !busy && (
          <p className="small faint">
            Checking asks you once, in a {platform === "macos" ? "macOS" : "system"} dialog, before Desk reaches the new address from {thisComputerLower(platform)}. Nothing changes until you switch.
          </p>
        )}

        <footer className="sheet-foot">
          <button type="button" className="btn btn-ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn-signal" disabled={!canGo} onClick={go}>
            {label}
          </button>
        </footer>
      </div>
    </div>
  );
}
