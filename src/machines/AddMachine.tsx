import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { plainError } from "../ui/plainError";
import { setUp, setupFailed, START, step, type Item } from "./addFlow";
import { native as realNative, type MachineNative } from "./native";
import { EngineBlocks } from "../settings/EngineBlocks";

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

/** One row of the checklist. */
function Check({ item, text }: { item: Item; text: string }) {
  return (
    <li className="machine-check">
      <span className={DOT[item.state]} aria-hidden="true" />
      <span className="machine-check-text">
        <span className={item.state === "waiting" ? "faint" : item.state === "failed" ? "state-blocked" : undefined}>{text}</span>
        {item.message && item.state !== "failed" && <span className="small muted">{item.message}</span>}
        {item.line && <Line text={item.line} />}
      </span>
    </li>
  );
}

const checkText = {
  connect: (i: Item, name: string) => i.detail ?? (i.state === "failed" ? (i.message ?? `Couldn’t connect to ${name}`) : `Connecting to ${name}…`),
  install: (i: Item) =>
    i.state === "done"
      ? (i.detail ?? "Desk installed, and set to start when it boots")
      : i.state === "running"
        ? (i.detail ?? "Installing Desk…")
        : i.state === "failed"
          ? (i.message ?? "Desk couldn’t be installed")
          : i.state === "blocked"
            ? (i.detail ?? "Desk is installed. To start it when the machine boots, run this there:")
            : "Install Desk, and start it when it boots",
  engines: (i: Item) =>
    i.state === "done"
      ? (i.detail ?? "Claude Code and Codex installed")
      : i.state === "running"
        ? (i.detail ?? "Installing Claude Code and Codex…")
        : i.state === "failed"
          ? (i.message ?? "Claude Code and Codex couldn’t be installed")
          : "Install Claude Code and Codex",
};

/** Settings → Machines → Add machine: the address, then what that machine
 *  needs (trusting it, this computer's key there), then setting it up and
 *  signing in there. Every step but typing runs on the native side. */
export function AddMachine({ onClose, native = realNative }: { onClose: () => void; native?: MachineNative }) {
  const [flow, dispatch] = useReducer(step, START);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const addr = useId();
  const added = useRef(false);

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
        dispatch({ type: "failed", message: plainError(e) });
      });
  }, [flow, native]);

  useEffect(() => native.setup((event) => dispatch({ type: "setup", event })), [native]);

  const signedIn = useCallback((engine: "claude" | "codex") => dispatch({ type: "signedIn", engine }), []);
  const editing = flow.at === "address";
  const target = flow.target;
  const failed = setupFailed(flow);
  const ready = setUp(flow);

  return (
    // Once it's being set up, only Do this later and Done close it: a click
    // beside it or Esc (back from the browser) never ends a sign-in's card.
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && flow.at !== "setup" && onClose()}>
      <form
        className="sheet machine-add"
        aria-label="Add a machine"
        onSubmit={(e) => {
          e.preventDefault();
          if (editing) dispatch({ type: "submit" });
        }}
        onKeyDown={(e) => e.key === "Escape" && flow.at !== "setup" && onClose()}
      >
        <h2 className="display-md">Add a machine</h2>
        <div className="field">
          <label htmlFor={addr} className="ov-label muted">
            Address
          </label>
          <input
            id={addr}
            className="field-text mono"
            value={target}
            readOnly={!editing}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="devbox"
            onChange={(e) => dispatch({ type: "edit", target: e.target.value })}
          />
          <span className="small muted">
            A host from your SSH config, or user@address. Jump hosts and cloud tunnels in your SSH config work as they do in a terminal.
          </span>
          {flow.at === "address" && flow.problem && !flow.refused && (
            <span className="small state-blocked" role="alert">
              {flow.problem}
            </span>
          )}
        </div>

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

        {flow.at === "checking" && <p className="small muted">Looking at {target}…</p>}

        {(flow.at === "trust" || flow.at === "trusting") && (
          <div className="machine-box" role="group" aria-label="New machine">
            <span className="ov-label muted">New machine</span>
            <span>Desk hasn’t connected to {flow.at === "trust" ? flow.name : target} before. Its fingerprint is</span>
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

        {flow.at === "changed" && (
          <div className="machine-box" role="alert" aria-label="Its key has changed">
            <span className="ov-label state-blocked">Its key has changed</span>
            <span>
              {flow.name} shows a different key from the one this computer knows ({flow.fingerprint}). Desk won’t connect to it. If the machine was reinstalled, remove
              its old key and add it again:
            </span>
            <Line text={`ssh-keygen -R ${flow.name}`} />
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
              <Check item={flow.steps.connect} text={checkText.connect(flow.steps.connect, flow.name)} />
              <Check item={flow.steps.install} text={checkText.install(flow.steps.install)} />
              <Check item={flow.steps.engines} text={checkText.engines(flow.steps.engines)} />
              <Check
                item={{ state: flow.signedIn.claude ? "done" : ready ? "running" : "waiting" }}
                text={flow.signedIn.claude ? `Signed in${flow.signedIn.codex ? " to Claude and ChatGPT" : " to Claude"}` : "Sign in"}
              />
            </ul>
            {failed && (
              <p className="small state-blocked" role="alert">
                Setting it up stopped there. {flow.name} stays in Settings → Machines: Try again there picks up once that’s fixed, or Remove… takes it off.
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
                <button type="submit" className="btn btn-signal" disabled={!editing || !target.trim()}>
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
