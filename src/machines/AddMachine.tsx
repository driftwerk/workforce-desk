import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { EngineBlocks } from "../settings/EngineBlocks";
import { useHost } from "../shell/host";
import { askDesk, useCanAskDesk } from "../ui/askDesk";
import { redact } from "../ui/redact";
import { plainError } from "../ui/plainError";
import { CANCELLED, setUp, START, step, type Item } from "./addFlow";
import { useMachines } from "./engines";
import { native as realNative, type HostEntry, type LogLine, type MachineNative } from "./native";
import { clock, sameHostAs, suggestedName, thisComputerLower, userOf } from "./words";

/** Copies `text`, saying so on the button for a moment. */
function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** A line to run in a terminal, with Copy. */
function Line({ text }: { text: string }) {
  return (
    <span className="machine-line">
      <code className="mono small">{text}</code>
      <CopyButton text={text} />
    </span>
  );
}

const DOT: Record<Item["state"], string> = { waiting: "dot", running: "dot dot-working", done: "dot dot-done", failed: "dot dot-failed", blocked: "dot dot-blocked" };

/** One row of the checklist; `children` under it (a failed step's way out). */
function Check({ item, text, children }: { item: Item; text: string; children?: React.ReactNode }) {
  return (
    <li className="machine-check">
      <span className={DOT[item.state]} aria-hidden="true" />
      <span className="machine-check-text">
        <span className={item.state === "waiting" ? "faint" : item.state === "failed" ? "state-blocked" : undefined}>{text}</span>
        {item.message && item.state !== "failed" && <span className="small muted">{item.message}</span>}
        {item.line && <Line text={item.line} />}
        {children}
      </span>
    </li>
  );
}

const checkText = {
  connect: (i: Item, name: string) => i.detail ?? (i.state === "failed" ? `Couldn’t connect to ${name}.` : `Connecting to ${name}…`),
  install: (i: Item) =>
    i.state === "failed"
      ? "Desk couldn’t be installed there."
      : i.state === "done"
        ? (i.detail ?? "Desk installed, and set to start when it boots")
        : i.state === "running"
          ? (i.detail ?? "Installing Desk…")
          : i.state === "blocked"
            ? (i.detail ?? "Desk is installed. To start it when the machine boots, run this there:")
            : "Install Desk, and start it when it boots",
  engines: (i: Item) =>
    i.state === "done"
      ? (i.detail ?? "Claude Code and Codex installed")
      : i.state === "running"
        ? (i.detail ?? "Installing Claude Code and Codex…")
        : i.state === "failed"
          ? "Claude Code and Codex couldn’t be installed there."
          : "Install Claude Code and Codex",
};

/** How long "Stopping…" waits for Cancel adding to take effect. */
export const STOP_WITHIN_MS = 15_000;

/** What to do about a failed step, beside Retry. */
const failedHint = (i: Item): string =>
  /free|space|No space/i.test(i.message ?? "") ? "Free some space there, then Retry." : /3 minutes/.test(i.message ?? "") ? "Retry once it can go faster." : "Fix that there, then Retry.";

/** The log of the machine being added, as this computer kept it. */
function SetupLog({ machine, native }: { machine: string; native: MachineNative }) {
  const [lines, setLines] = useState<LogLine[] | null>(null);
  useEffect(() => {
    let live = true;
    void native
      .log(machine)
      .then((l) => live && setLines(l))
      .catch(() => live && setLines([]));
    return () => {
      live = false;
    };
  }, [machine, native]);
  return (
    <div className="machine-log" role="log" aria-label="Adding it, as this computer logged it">
      {lines === null ? (
        <span className="faint">Reading…</span>
      ) : lines.length === 0 ? (
        <span className="faint">Nothing yet.</span>
      ) : (
        lines.map((l, n) => (
          <div key={n} className="machine-log-line">
            <span className="faint">{clock(l.at)}</span>
            <span className={`machine-log-${l.kind}`}>{l.text}</span>
          </div>
        ))
      )}
    </div>
  );
}

/** Where an SSH config entry goes: `dev@2.29.244.77`. */
const whereOf = (e: HostEntry): string => [e.user && `${e.user}@`, e.hostname ?? e.host, e.port && e.port !== "22" ? `:${e.port}` : ""].filter(Boolean).join("");

/** Settings → Machines → Add machine: a Host from the SSH config or a
 *  typed address, and its name; then what that machine needs (trusting it,
 *  this computer's key there); then setting it up step by step, each step
 *  cancellable and stopped after 3 minutes, a failed one said in place with
 *  Retry and View log; then signing in there. Every step but typing runs on
 *  the native side. */
export function AddMachine({ onClose, native = realNative, target: given }: { onClose: () => void; native?: MachineNative; target?: string }) {
  const [flow, dispatch] = useReducer(step, START, (s) => (given ? { ...s, target: given } : s));
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [hosts, setHosts] = useState<HostEntry[] | null>(null);
  const [showLog, setShowLog] = useState(false);
  const machines = useMachines((s) => s.machines);
  const platform = useHost((h) => h.platform);
  const addr = useId();
  const nameId = useId();
  const added = useRef(false);
  const addrInput = useRef<HTMLInputElement>(null);

  // The SSH config's entries, read once (its text only).
  useEffect(() => {
    let live = true;
    native
      .sshHosts()
      .then((h) => live && setHosts(h))
      .catch(() => live && setHosts([]));
    return () => {
      live = false;
    };
  }, [native]);

  // An SSH config entry picked: the address field isn't the one in use, so
  // it shows no focus.
  const picked = flow.at === "address" ? flow.picked : null;
  useEffect(() => {
    if (picked && document.activeElement === addrInput.current) addrInput.current?.blur();
  }, [picked]);

  // The name follows the address until the person types one.
  const entryUser = flow.at === "address" && flow.picked ? (hosts?.find((h) => h.host === flow.picked)?.user ?? null) : null;
  const target = flow.target;
  useEffect(() => {
    if (flow.at === "address" && !flow.named) dispatch({ type: "name", name: suggestedName(target, machines, entryUser), typed: false });
  }, [flow.at, target, entryUser, machines, flow.at === "address" && flow.named]);

  // Each state's native call, once.
  useEffect(() => {
    let live = true;
    const fail = (e: unknown) => live && dispatch({ type: "failed", message: plainError(e) });
    if (flow.at === "checking")
      native
        .probe(flow.target)
        .then((probe) => live && dispatch({ type: "probed", probe }))
        .catch(fail);
    if (flow.at === "trusting")
      native
        .trust(flow.target, flow.fingerprint)
        .then(() => live && dispatch({ type: "trusted" }))
        .catch(fail);
    if (flow.at === "key" && flow.why === "refused")
      native
        .publicKey()
        .then((k) => live && setPublicKey(k))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [flow.at, native]);

  // Adding goes on even if the card is closed ("Do this later"): it isn't
  // cancelled with it.
  useEffect(() => {
    if (flow.at !== "setup" || flow.machine || added.current) return;
    added.current = true;
    native
      .add(flow.target, flow.name)
      .then((machine) => dispatch({ type: "added", machine }))
      .catch((e: unknown) => {
        added.current = false;
        // Cancelled before it was added (while its question was open): gone.
        if (plainError(e) === CANCELLED) return onClose();
        dispatch({ type: "failed", message: plainError(e) });
      });
  }, [flow, native]);

  useEffect(() => native.setup((event) => dispatch({ type: "setup", event })), [native]);

  // Cancelled: it's gone, and so is the card.
  const cancelled = flow.at === "setup" && flow.cancelled;
  useEffect(() => {
    if (cancelled) onClose();
  }, [cancelled, onClose]);

  const signedIn = useCallback((engine: "claude" | "codex") => dispatch({ type: "signedIn", engine }), []);
  const editing = flow.at === "address";
  const ready = setUp(flow);
  const here = thisComputerLower(platform);
  const taken = machines.map((m) => m.name);
  const name = "name" in flow ? (flow.name ?? "") : "";
  const asking = editing || flow.at === "checking";
  const user = asking ? userOf(target, entryUser) : null;
  const twin = asking && target.trim() ? sameHostAs(target.trim(), machines) : null;
  const root = asking && user === "root";

  /** Cancel adding: by its id once known, else by its address while its
   *  question is open, so it stops once the person answers. A refusal is
   *  said, and Cancel adding works again. */
  const cancelAdding = () => {
    if (flow.at !== "setup") return onClose();
    dispatch({ type: "cancelling" });
    native.cancelAdd(flow.machine ?? flow.target).catch((e: unknown) => dispatch({ type: "cancelFailed", message: plainError(e) }));
  };
  // "Stopping…" has a limit too.
  const stopping = flow.at === "setup" && !!flow.cancelling;
  useEffect(() => {
    if (!stopping) return;
    const t = setTimeout(
      () => dispatch({ type: "cancelFailed", message: `Desk couldn’t stop it within ${STOP_WITHIN_MS / 1000} s. It may still be set up: Cancel adding again, or remove it from Settings → Machines.` }),
      STOP_WITHIN_MS,
    );
    return () => clearTimeout(t);
  }, [stopping]);
  // A machine on a newer Desk than this one: kept, and nothing to retry.
  const newer = flow.at === "setup" && !!flow.machine && machines.some((m) => m.id === flow.machine && m.state.kind === "newer");
  const retry = () => {
    if (flow.at !== "setup" || !flow.machine) return;
    setShowLog(false);
    // Engines fail after the machine is added: only that step runs again.
    if (flow.steps.engines.state === "failed") {
      dispatch({ type: "retryingEngines" });
      native.retryEngines(flow.machine).catch((e: unknown) => dispatch({ type: "setup", event: { machine: flow.machine!, step: "engines", state: "failed", message: plainError(e) } }));
      return;
    }
    dispatch({ type: "retrying" });
    native.reconnect(flow.machine).catch((e: unknown) => dispatch({ type: "failed", message: plainError(e) }));
  };

  const canAsk = useCanAskDesk();
  /** Hands the failed step, with this computer's log of it, to Desk's agent. */
  const askToLook = async (i: Item) => {
    const id = flow.at === "setup" ? (flow.machine ?? flow.target) : "";
    const lines = await native.log(id).catch(() => [] as LogLine[]);
    askDesk({
      plain: `Adding ${flow.at === "setup" ? flow.name : "a machine"} stopped on a step.`,
      what: "adding a machine in Settings → Machines",
      details: [redact(i.message ?? ""), ...lines.slice(-40).map((l) => redact(`${clock(l.at)} ${l.text}`))].filter(Boolean).join("\n"),
    });
  };

  /** A failed step's way out, in place. */
  const wayOut = (i: Item) =>
    i.state === "failed" && newer ? (
      <span className="small muted">
        It runs a newer Desk than {here}. Update Desk on {here}: {flow.at === "setup" ? flow.name : "it"} stays in Settings → Machines and connects once they match.
      </span>
    ) : i.state === "failed" && flow.at === "setup" && flow.machine ? (
      <span className="machine-actions">
        <button type="button" className="btn btn-sm" onClick={retry}>
          Retry
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setShowLog((v) => !v)}>
          {showLog ? "Hide log" : "View log"}
        </button>
        {canAsk && (
          <button type="button" className="btn btn-sm" onClick={() => void askToLook(i)}>
            Ask Desk to look
          </button>
        )}
        <span className="small faint">{failedHint(i)}</span>
        {i.message && (
          <details className="problem-details">
            <summary className="small faint">Details</summary>
            <pre className="problem-raw mono small">{i.message}</pre>
          </details>
        )}
      </span>
    ) : i.state === "running" && flow.at === "setup" && !ready ? (
      <span className="small muted">
        Each step stops after 3 minutes and says why.{" "}
        <button type="button" className="link small" disabled={flow.cancelling} onClick={cancelAdding}>
          Cancel
        </button>
      </span>
    ) : null;

  const pickable = editing && hosts && hosts.length > 0;
  return (
    // Once it's being set up, only Do this later and Done close it: a click
    // beside it or Esc (back from the browser) never ends a sign-in's card.
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && flow.at !== "setup" && onClose()}>
      <form
        className="sheet machine-add"
        aria-label="Add a machine"
        onSubmit={(e) => {
          e.preventDefault();
          if (editing) dispatch({ type: "submit", taken });
        }}
        onKeyDown={(e) => e.key === "Escape" && flow.at !== "setup" && onClose()}
      >
        <h2 className="display-md">Add a machine</h2>
        {pickable && (
          <div className="field">
            <span className="ov-label muted">From your SSH config</span>
            <div className="pick-list" role="radiogroup" aria-label="From your SSH config">
              {hosts.map((h) => {
                const there = machines.some((m) => m.target === h.host);
                return (
                  <button
                    key={h.host}
                    type="button"
                    role="radio"
                    aria-checked={flow.picked === h.host}
                    className="pick-row"
                    disabled={there}
                    onClick={() => dispatch({ type: "pick", host: h.host })}
                  >
                    <span className="pick-ring" aria-hidden="true" />
                    <span className="pick-text">
                      <b className="mono">{h.host}</b>
                      <span className="mono muted">{whereOf(h)}</span>
                      {h.jump && <span className="pick-sub small faint">Through {h.jump}, as your SSH config says</span>}
                    </span>
                    {there && <span className="small faint">added</span>}
                    {h.jump && !there && <span className="chip">via {h.jump}</span>}
                  </button>
                );
              })}
            </div>
            <span className="small faint">Read from ~/.ssh/config and the files it includes. Entries with wildcards aren’t listed.</span>
          </div>
        )}
        <div className="field">
          <label htmlFor={addr} className="ov-label muted">
            {pickable ? "Or type an address" : "Address"}
          </label>
          <input
            id={addr}
            ref={addrInput}
            className="field-text mono"
            value={editing && flow.picked ? "" : target}
            readOnly={!editing}
            autoFocus={!pickable}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={pickable ? "user@address" : "devbox"}
            onChange={(e) => dispatch({ type: "edit", target: e.target.value })}
          />
          {editing && (
            <span className="small muted">
              {pickable ? "" : "A host from your SSH config, or user@address. "}Jump hosts and cloud tunnels in your SSH config work as they do in a terminal.
            </span>
          )}
          {flow.at === "address" && flow.problem && !flow.refused && (
            <span className="small state-blocked" role="alert">
              {flow.problem}
            </span>
          )}
        </div>
        {asking && (
          <div className="field">
            <label htmlFor={nameId} className="ov-label muted">
              Name
            </label>
            <input
              id={nameId}
              className="field-text"
              value={name}
              maxLength={60}
              readOnly={!editing}
              onChange={(e) => dispatch({ type: "name", name: e.target.value, typed: true })}
            />
            <span className="small muted">
              {twin
                ? `${twin.name} is already added as ${userOf(twin.target, twin.reach?.user) ?? "another user"}. This adds ${user ?? "this user"} on the same machine as its own machine.`
                : "How Desk shows it everywhere. Two machines can’t share a name."}
            </span>
          </div>
        )}
        {root && (
          <div className="machine-box" role="note" aria-label="Sessions would run as root">
            <span className="ov-label state-blocked">Sessions would run as root</span>
            <span className="small">Anything you start there runs as root, with full control of {nameFromTargetOf(target)}. A normal user is safer.</span>
          </div>
        )}

        {flow.at === "address" && flow.problem && flow.refused && (
          <div className="machine-box" role="alert" aria-label="Desk can’t add it">
            <span className="ov-label state-blocked">Desk can’t add it</span>
            <span>{flow.problem}</span>
            {flow.suggest ? (
              <div className="machine-actions">
                <span>
                  Did you mean <span className="mono">{flow.suggest}</span>?
                </span>
                <button type="button" className="btn btn-sm btn-signal" onClick={() => dispatch({ type: "edit", target: flow.suggest ?? "" })}>
                  Use {flow.suggest}
                </button>
              </div>
            ) : null}
            <span className="small muted">Change the address above to try another machine or account.</span>
          </div>
        )}

        {flow.at === "checking" && (
          <ul className="machine-checks" aria-live="polite">
            <Check item={{ state: "running" }} text={`Looking at ${target}…`}>
              <span className="small muted">
                Desk gives up after 15 s and says why.{" "}
                <button type="button" className="link small" onClick={() => dispatch({ type: "back" })}>
                  Cancel
                </button>
              </span>
            </Check>
          </ul>
        )}

        {(flow.at === "trust" || flow.at === "trusting") && (
          <div className="machine-box" role="group" aria-label="New machine">
            <span className="ov-label muted">New machine</span>
            <span>Desk hasn’t connected to {flow.name} before. Its fingerprint is</span>
            <span className="mono small muted">
              {flow.fingerprint}
              {flow.at === "trust" && ` (${flow.keyType})`}
            </span>
            <span className="small muted">If you know it, check it matches what the machine shows (ssh-keygen -lf on its host key).</span>
            <div className="machine-actions">
              <button type="button" className="btn btn-sm btn-signal" disabled={flow.at === "trusting"} onClick={() => dispatch({ type: "trust" })}>
                Trust this machine
              </button>
              <button type="button" className="btn btn-sm" onClick={() => dispatch({ type: "back" })}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {(flow.at === "trust" || flow.at === "trusting") && (
          <span className="small faint">Trusting asks you once more, in a {platform === "macos" ? "macOS" : "system"} dialog.</span>
        )}

        {flow.at === "changed" && (
          <div className="machine-box" role="alert" aria-label="Its key has changed">
            <span className="ov-label state-blocked">Its key has changed</span>
            <span>
              {flow.name} shows a different key from the one this computer knows ({flow.fingerprint}). Desk won’t connect to it. If the machine was reinstalled, remove
              its old key and add it again:
            </span>
            <Line text={flow.forgetKey ?? `ssh-keygen -R ${nameFromTargetOf(flow.target)}`} />
            <div className="machine-actions">
              <button type="button" className="btn btn-sm" onClick={() => dispatch({ type: "back" })}>
                Back
              </button>
            </div>
          </div>
        )}

        {flow.at === "key" && (
          <div className="machine-box" role="group" aria-label="This computer’s key">
            <span className="ov-label muted">{flow.why === "locked" ? "Your SSH key is locked" : `${flow.name} doesn’t know this computer yet`}</span>
            {flow.why === "locked" ? (
              <>
                <span>Your SSH key needs its passphrase, and no SSH agent holds it. Unlock it in a terminal, then try again:</span>
                <Line text="ssh-add" />
              </>
            ) : (
              <>
                <span>
                  {flow.name} didn’t take any of this computer’s SSH keys. Put yours in {flow.user ? `${flow.user}’s` : "its"} ~/.ssh/authorized_keys there, from a
                  terminal that can already sign in:
                </span>
                <Line text={`ssh-copy-id ${target}`} />
                {publicKey && (
                  <>
                    <span className="small muted">Or add this line to that file yourself:</span>
                    <span className="machine-line">
                      <code className="mono small machine-key">{publicKey}</code>
                      <CopyButton text={publicKey} />
                    </span>
                  </>
                )}
              </>
            )}
            <div className="machine-actions">
              <button type="button" className="btn btn-sm btn-signal" onClick={() => dispatch({ type: "retry" })}>
                Try again
              </button>
              <button type="button" className="btn btn-sm" onClick={() => dispatch({ type: "back" })}>
                Back
              </button>
            </div>
          </div>
        )}

        {flow.at === "setup" && (
          <div className="machine-setup" role="group" aria-label="Setting it up">
            <span className="ov-label muted">Setting it up</span>
            <ul className="machine-checks" aria-live="polite">
              <Check item={flow.steps.connect} text={checkText.connect(flow.steps.connect, flow.name)}>
                {wayOut(flow.steps.connect)}
              </Check>
              <Check item={flow.steps.install} text={checkText.install(flow.steps.install)}>
                {wayOut(flow.steps.install)}
              </Check>
              <Check item={flow.steps.engines} text={checkText.engines(flow.steps.engines)}>
                {wayOut(flow.steps.engines)}
              </Check>
              <Check
                item={{ state: flow.signedIn.claude ? "done" : ready ? "running" : "waiting" }}
                text={flow.signedIn.claude ? `Signed in${flow.signedIn.codex ? " to Claude and ChatGPT" : " to Claude"}` : "Sign in"}
              />
            </ul>
            {showLog && flow.machine && <SetupLog machine={flow.machine} native={native} />}
            {flow.cancelling && <p className="small muted">Stopping… whatever runs there now is ended. Desk gives up after {STOP_WITHIN_MS / 1000} s and says why.</p>}
            {flow.cancelProblem && (
              <p className="small state-blocked" role="alert">
                {flow.cancelProblem}
              </p>
            )}
          </div>
        )}

        {flow.at === "setup" && ready && flow.machine && (
          <div className="machine-box" role="group" aria-label={`Sign in on ${flow.name}`}>
            <span className="ov-label muted">Sign in on {flow.name}</span>
            <EngineBlocks machine={flow.machine} name={flow.name} native={native} onSignedIn={signedIn} only={["claude", "codex"]} />
          </div>
        )}

        <footer className="sheet-foot">
          {flow.at === "setup" ? (
            <>
              {!ready && !newer && (
                <button type="button" className="btn machine-cancel-add" disabled={flow.cancelling} onClick={cancelAdding}>
                  Cancel adding
                </button>
              )}
              <button type="button" className="btn" onClick={onClose}>
                Do this later
              </button>
              <button type="button" className="btn btn-signal" disabled={!ready} onClick={onClose}>
                Done
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              {(editing || flow.at === "checking") && (
                <button type="submit" className="btn btn-signal" disabled={!editing || !target.trim() || !name.trim()}>
                  Continue
                </button>
              )}
            </>
          )}
        </footer>
      </form>
    </div>
  );
}

/** The host a target names (`devbox` in `root@devbox`). */
const nameFromTargetOf = (target: string): string => target.slice(target.lastIndexOf("@") + 1);
