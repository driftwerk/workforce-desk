import { useEffect, useRef, useState } from "react";
import { useDesk } from "../hub/store";
import { cancelLogin, onLoginProgress, openUrl, sendLoginCode, startLogin, subscribe, type LoginProgress, type PlanName } from "../platform";

/** A plan's one-click sign-in through its own page in the browser. */
export function usePlanLogin(plan: PlanName | undefined, onConnected: () => void) {
  const fail = useDesk((s) => s.fail);
  const [progress, setProgress] = useState<LoginProgress | null>(null);
  const [code, setCode] = useState("");
  const connectedRef = useRef(onConnected);
  connectedRef.current = onConnected;

  useEffect(() => {
    if (!plan) return;
    return subscribe(
      onLoginProgress((p, next) => {
        if (p !== plan) return;
        setProgress(next);
        if (next.state === "done") connectedRef.current();
      }),
    );
  }, [plan]);

  const busy = progress !== null && !["done", "failed"].includes(progress.state);
  const status = (() => {
    switch (progress?.state) {
      case "starting":
        return "Opening the sign-in page…";
      case "browser":
        return "Finish signing in in your browser.";
      case "needs-code":
        return "Paste the code the page shows you.";
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
    progress,
    status,
    failed: progress?.state === "failed",
    busy,
    code,
    setCode,
    start: () => plan && startLogin(plan).catch(fail),
    cancel: () => plan && void cancelLogin(plan).then(() => setProgress(null)),
    send: () => plan && sendLoginCode(plan, code).then(() => setCode(""), fail),
  };
}

export type PlanLoginState = ReturnType<typeof usePlanLogin>;

/** "Open it again" while the browser page is open. */
export function ReopenLink({ login }: { login: PlanLoginState }) {
  if (login.progress?.state !== "browser") return null;
  const url = login.progress.url;
  return (
    <>
      {" "}
      <button type="button" className="link small" onClick={() => openUrl(url)}>
        Open it again
      </button>
    </>
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
      </span>
    );
  }
  if (login.busy) {
    return (
      <button type="button" className="btn" onClick={login.cancel}>
        Cancel
      </button>
    );
  }
  return (
    <button type="button" className={`btn ${signal ? "btn-signal" : ""}`} onClick={() => void login.start()}>
      {label}
    </button>
  );
}
