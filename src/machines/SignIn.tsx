import { useEffect, useState } from "react";
import { signInStep } from "../engines/accounts";
import type { DeskHub } from "../hub/client";
import type { AccountSignIn, Engine } from "../hub/types";
import { openUrl } from "../platform";
import { useHost } from "../shell/host";
import { plainError } from "../ui/plainError";
import { useHubOf, type MachineId } from "./engines";
import type { MachineNative } from "./native";
import { thisComputerLower } from "./words";

/** How often a sign-in in the browser is read again, while it waits. */
export const SIGN_IN_POLL_MS = 2000;

/** "Sign in on devbox": Claude with this computer's account or another, and
 *  ChatGPT for Codex if the person wants it. Each sign-in is kept on the
 *  machine; one in the browser is the machine's own engine's sign-in, its
 *  page opened here and its code pasted back. */
export function SignInOn({
  machine,
  name,
  native,
  signedIn,
  onSignedIn,
}: {
  machine: MachineId;
  name: string;
  native: MachineNative;
  signedIn: { claude: boolean; codex: boolean };
  onSignedIn: (engine: "claude" | "codex") => void;
}) {
  const hub = useHubOf(machine);
  const platform = useHost((h) => h.platform);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [signing, setSigning] = useState<{ engine: "claude" | "codex"; signIn: AccountSignIn } | null>(null);

  const share = async () => {
    setBusy("share");
    setProblem(null);
    try {
      await native.shareSignIn(machine, "claude");
      onSignedIn("claude");
    } catch (e) {
      setProblem(plainError(e));
    } finally {
      setBusy(null);
    }
  };
  const begin = async (engine: "claude" | "codex") => {
    if (!hub) return;
    setBusy(engine);
    setProblem(null);
    try {
      const added = await hub.addAccount({ engine: engine as Engine, name: engine === "claude" ? "Claude" : "ChatGPT", makeDefault: true });
      if (added.kind === "account") onSignedIn(engine);
      else {
        setSigning({ engine, signIn: added.signIn });
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
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void share()}>
              Use {thisComputerLower(platform)}’s account
            </button>
            <button type="button" className="btn btn-sm" disabled={!!busy || !hub} onClick={() => void begin("claude")}>
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
          <>
            <button type="button" className="btn btn-sm" disabled={!!busy || !hub} onClick={() => void begin("codex")}>
              Sign in…
            </button>
            <span className="small muted">optional, for Codex</span>
          </>
        )}
      </div>
      {signing && hub && (
        <SigningIn
          hub={hub}
          signIn={signing.signIn}
          onDone={(ok) => {
            if (ok) onSignedIn(signing.engine);
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
