import { useEffect, useState } from "react";
import { signInStep } from "../engines/accounts";
import type { DeskHub } from "../hub/client";
import type { AccountSignIn } from "../hub/types";
import { openUrl } from "../platform";
import { plainError } from "../ui/plainError";
import { useHubOf, type MachineId } from "./engines";
import { openTerminalOn } from "./watch";

/** Codex's sign-in for a computer with no browser of its own. */
export const CODEX_LOGIN = "codex login --device-auth";

/** How often a sign-in in the browser is read again, while it waits. */
export const SIGN_IN_POLL_MS = 2000;

/** "Sign in on devbox": Claude through the machine's own engine (its sign-in
 *  page opened here, its code pasted back), and ChatGPT for Codex if the
 *  person wants it, in a terminal there. Each sign-in is kept on the
 *  machine. Nothing is offered that only refuses: using this computer's
 *  Claude account there waits on `machine_share_sign_in`, and the hub's
 *  accounts can't sign Codex in from here. */
export function SignInOn({
  machine,
  name,
  signedIn,
  onSignedIn,
}: {
  machine: MachineId;
  name: string;
  signedIn: { claude: boolean; codex: boolean };
  onSignedIn: (engine: "claude" | "codex") => void;
}) {
  const hub = useHubOf(machine);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [signing, setSigning] = useState<AccountSignIn | null>(null);

  const begin = async () => {
    if (!hub) return;
    setBusy("claude");
    setProblem(null);
    try {
      const added = await hub.addAccount({ engine: "claude", name: "Claude", makeDefault: true });
      if (added.kind === "account") onSignedIn("claude");
      else {
        setSigning(added.signIn);
        const url = "url" in added.signIn ? added.signIn.url : null;
        if (url) openUrl(url);
      }
    } catch (e) {
      setProblem(plainError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="machine-box" role="group" aria-label={`Sign in on ${name}`}>
      <span className="ov-label muted">Sign in on {name}</span>
      {!hub && <span className="small muted">Waiting for {name} to connect…</span>}
      <div className="machine-signin-row">
        <b className="machine-signin-name">Claude</b>
        {signedIn.claude ? (
          <span className="small">Signed in</span>
        ) : (
          <>
            <button type="button" className="btn btn-sm" disabled={!!busy || !hub} onClick={() => void begin()}>
              Sign in to another…
            </button>
          </>
        )}
      </div>
      <div className="machine-signin-row">
        <b className="machine-signin-name">ChatGPT</b>
        {signedIn.codex ? (
          <span className="small">Signed in</span>
        ) : (
          <span className="machine-signin-terminal">
            <span className="small muted">Optional, for Codex. Sign in in a terminal on {name}:</span>
            <span className="machine-line">
              <code className="mono small">{CODEX_LOGIN}</code>
              <button type="button" className="btn btn-sm" onClick={() => openTerminalOn(machine)}>
                Open a terminal
              </button>
            </span>
          </span>
        )}
      </div>
      {signing && hub && (
        <SigningIn
          hub={hub}
          signIn={signing}
          onDone={(ok) => {
            if (ok) onSignedIn("claude");
            setSigning(null);
          }}
        />
      )}
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/** A sign-in in the browser, for an engine on the machine: read again while
 *  it waits, with the code field when the page shows one. */
function SigningIn({ hub, signIn: first, onDone }: { hub: DeskHub; signIn: AccountSignIn; onDone: (ok: boolean) => void }) {
  const [signIn, setSignIn] = useState(first);
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const over = signIn.state === "done" || signIn.state === "failed";
  useEffect(() => {
    if (over) return;
    const t = setInterval(() => {
      void hub
        .accounts()
        .then((a) => {
          const now = a?.signIns.find((s) => s.id === signIn.id);
          if (now) setSignIn(now);
          else if (a?.accounts.some((x) => x.engine === signIn.engine && x.name === signIn.name)) setSignIn({ ...signIn, state: "done", account: "" });
        })
        .catch(() => undefined);
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(t);
  }, [hub, signIn, over]);
  useEffect(() => {
    if (signIn.state === "done") onDone(true);
  }, [signIn.state, onDone]);
  const url = signIn.state === "open" || signIn.state === "code" ? signIn.url : null;
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSignIn(await hub.signInCode(signIn.id, code.trim()));
      setCode("");
    } catch (err) {
      setProblem(plainError(err));
    }
  };
  return (
    <div className="machine-signing" aria-live="polite">
      <p className={signIn.state === "failed" ? "state-blocked small" : "small"}>{signInStep(signIn)}</p>
      {url && (
        <span>
          <button type="button" className="btn btn-sm" onClick={() => openUrl(url)}>
            Open the sign-in page again
          </button>
        </span>
      )}
      {signIn.state === "code" && (
        <form className="field-row" onSubmit={send} aria-label="Sign-in code">
          <input className="field-text mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code from the page" autoComplete="off" spellCheck={false} />
          <button type="submit" className="btn btn-sm" disabled={!code.trim()}>
            Send
          </button>
        </form>
      )}
      {problem && <p className="state-blocked small">{problem}</p>}
      <span>
        <button
          type="button"
          className="link small"
          onClick={() => {
            if (!over) void hub.cancelSignIn(signIn.id).catch(() => undefined);
            onDone(false);
          }}
        >
          {over ? "Close" : "Cancel"}
        </button>
      </span>
    </div>
  );
}
