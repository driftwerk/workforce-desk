import { type ReactNode, useEffect, useRef, useState } from "react";
import { useDesk } from "../hub/store";
import {
  cancelLogin,
  cliInstalled,
  installCli,
  onInstallProgress,
  onLoginProgress,
  openUrl,
  sendLoginCode,
  startLogin,
  subscribe,
  type InstallProgress,
  type LoginProgress,
  type PlanName,
} from "../platform";

/** The CLI each plan signs in with. */
export const CLI_NAME: Record<PlanName, string> = { claude: "Claude Code", chatgpt: "Codex" };

/** A plan's one-click sign-in through its own page in the browser —
 *  installing its CLI first when this computer doesn't have it. */
export function usePlanLogin(plan: PlanName | undefined, onConnected: () => void) {
  const fail = useDesk((s) => s.fail);
  const [progress, setProgress] = useState<LoginProgress | null>(null);
  // The sign-in page, kept while the sign-in waits for a code too.
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // Null until known; anything Desk can't check counts as installed, so
  // sign-in says what's wrong itself.
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [install, setInstall] = useState<InstallProgress | null>(null);
  const connectedRef = useRef(onConnected);
  connectedRef.current = onConnected;

  useEffect(() => {
    if (!plan) return;
    let live = true;
    cliInstalled(plan)
      .then((yes) => live && setInstalled(yes))
      .catch(() => live && setInstalled(true));
    const off = subscribe(
      onInstallProgress((p, next) => {
        if (p !== plan) return;
        if (next.state !== "done") return setInstall(next);
        setInstall(null);
        setInstalled(true);
        startLogin(plan).catch(fail);
      }),
    );
    return () => {
      live = false;
      off();
    };
  }, [plan, fail]);

  useEffect(() => {
    if (!plan) return;
    return subscribe(
      onLoginProgress((p, next) => {
        if (p !== plan) return;
        setProgress(next);
        if (next.state === "browser") setUrl(next.url);
        else if (next.state !== "needs-code") setUrl(null);
        // The pasted code is kept no longer than the sign-in.
        if (next.state === "done" || next.state === "failed") setCode("");
        if (next.state === "done") connectedRef.current();
      }),
    );
  }, [plan]);

  const installing = install?.state === "running";
  const busy = installing || (progress !== null && !["done", "failed"].includes(progress.state));
  const status = (() => {
    if (plan && installing) return `Installing ${CLI_NAME[plan]}… ${install.line}`;
    if (install?.state === "failed") return install.message;
    switch (progress?.state) {
      case "starting":
        return "Opening the sign-in page…";
      case "browser":
        return "Finish signing in in your browser.";
      case "needs-code":
        return "Finish signing in in your browser. If the page shows a code, paste it here.";
      case "saving":
        return "Connecting…";
      case "done":
        return "Connected.";
      case "failed":
        return progress.message;
      default:
        return null;
    }
  })();

  return {
    plan,
    progress,
    /** The sign-in page while the sign-in waits on it. */
    url: busy ? url : null,
    status,
    failed: progress?.state === "failed" || install?.state === "failed",
    /** What to run in a terminal by hand when the install stopped. */
    manual: install?.state === "failed" && install.command ? { command: install.command, hint: install.hint } : null,
    busy,
    installing,
    /** False when the plan's CLI isn't on this computer yet. */
    installed,
    install: () => {
      if (!plan) return;
      setInstall({ state: "running", line: "" });
      setProgress(null);
      installCli(plan).catch((e: unknown) => setInstall({ state: "failed", message: e instanceof Error ? e.message : String(e) }));
    },
    code,
    setCode,
    start: () => plan && startLogin(plan).catch(fail),
    cancel: () =>
      plan &&
      void cancelLogin(plan).then(() => {
        setProgress(null);
        setUrl(null);
        setCode("");
      }, fail),
    send: () => plan && sendLoginCode(plan, code).then(() => setCode(""), fail),
  };
}

export type PlanLoginState = ReturnType<typeof usePlanLogin>;

/** While the sign-in waits on its page: the page's address with a Copy
 *  button (to open it in another browser), and "Open it again". */
export function ReopenLink({ login }: { login: PlanLoginState }) {
  const url = login.url;
  if (!url) return null;
  return (
    <>
      {" "}
      <button type="button" className="link small" onClick={() => openUrl(url)}>
        Open it again
      </button>
      <CopyText text={url} label="Copy link" />
    </>
  );
}

/** `text` in code type with a Copy button; where the clipboard won't take
 *  it, the text is left selected to copy by hand. */
function CopyText({ text, label, children }: { text: string; label: string; children?: ReactNode }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const code = useRef<HTMLElement>(null);
  const copy = () =>
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => setCopied("yes"))
      .catch(() => {
        if (code.current) window.getSelection()?.selectAllChildren(code.current);
        setCopied("no");
      })
      .finally(() => setTimeout(() => setCopied(null), 3000));
  return (
    <span className="install-manual">
      <code ref={code} className="mono small">
        {text}
      </code>
      <button type="button" className="btn btn-sm" onClick={() => void copy()}>
        {copied === "yes" ? "Copied" : label}
      </button>
      {copied === "no" && <span className="small state-blocked">Couldn’t copy, select and copy it</span>}
      {children}
    </span>
  );
}

/** After an install that stopped: the installer's command to run by hand,
 *  with where to run it. */
export function CopyInstall({ login }: { login: PlanLoginState }) {
  if (!login.manual) return null;
  const { command, hint } = login.manual;
  return (
    <CopyText text={command} label="Copy command">
      {hint && <span className="small muted">{hint}</span>}
    </CopyText>
  );
}

/** The sign-in's control: a code field when the page shows one, Cancel
 *  while it runs, else `label`. */
export function PlanLoginAction({ login, label, signal = true }: { login: PlanLoginState; label: string; signal?: boolean }) {
  if (login.progress?.state === "needs-code") {
    return (
      <span className="field-row plan-field">
        <input
          value={login.code}
          autoFocus
          aria-label="Code from the sign-in page"
          placeholder="Code from the page"
          onChange={(e) => login.setCode(e.target.value)}
        />
        <button type="button" className="btn btn-signal" disabled={!login.code.trim()} onClick={() => void login.send()}>
          Send
        </button>
        <button type="button" className="btn" onClick={login.cancel}>
          Cancel
        </button>
      </span>
    );
  }
  if (login.installing) {
    return (
      <button type="button" className="btn" disabled>
        Installing…
      </button>
    );
  }
  if (login.busy) {
    return (
      <button type="button" className="btn" onClick={login.cancel}>
        Cancel
      </button>
    );
  }
  if (login.installed === false && login.plan) {
    return (
      <button type="button" className={`btn ${signal ? "btn-signal" : ""}`} onClick={login.install}>
        Install {CLI_NAME[login.plan]}
      </button>
    );
  }
  return (
    <button type="button" className={`btn ${signal ? "btn-signal" : ""}`} onClick={() => void login.start()}>
      {label}
    </button>
  );
}
