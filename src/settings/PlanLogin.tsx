import { useEffect, useRef, useState } from "react";
import { useDesk } from "../hub/store";
import { cancelLogin, onLoginProgress, openUrl, sendLoginCode, startLogin, subscribe, type LoginProgress, type PlanName } from "../platform";

const LABEL: Record<PlanName, string> = { claude: "Claude", chatgpt: "ChatGPT" };

/** One plan's row: connected or not, and a one-click sign-in through the
 *  plan's own page in the browser. */
export function PlanLogin({ plan, connected, onConnected }: { plan: PlanName; connected: boolean; onConnected: () => void }) {
  const fail = useDesk((s) => s.fail);
  const [progress, setProgress] = useState<LoginProgress | null>(null);
  const [code, setCode] = useState("");
  const connectedRef = useRef(onConnected);
  connectedRef.current = onConnected;

  useEffect(
    () =>
      subscribe(
        onLoginProgress((p, next) => {
          if (p !== plan) return;
          setProgress(next);
          if (next.state === "done") connectedRef.current();
        }),
      ),
    [plan],
  );

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
        return connected ? "Connected" : "Not connected";
    }
  })();

  return (
    <div className="hub-row plan-row">
      <span className="hub-name">
        <b className="display">{LABEL[plan]}</b>
        <span className={`small ${progress?.state === "failed" ? "state-blocked" : "muted"}`}>
          {status}
          {progress?.state === "browser" && (
            <>
              {" "}
              <button type="button" className="link small" onClick={() => openUrl(progress.url)}>
                Open it again
              </button>
            </>
          )}
        </span>
      </span>
      {progress?.state === "needs-code" ? (
        <span className="field-row plan-field">
          <input value={code} autoFocus placeholder="Code from the page" onChange={(e) => setCode(e.target.value)} />
          <button
            type="button"
            className="btn btn-signal"
            disabled={!code.trim()}
            onClick={() => sendLoginCode(plan, code).then(() => setCode(""), fail)}
          >
            Send
          </button>
        </span>
      ) : busy ? (
        <button type="button" className="btn" onClick={() => void cancelLogin(plan).then(() => setProgress(null))}>
          Cancel
        </button>
      ) : (
        <button type="button" className="btn btn-signal" onClick={() => startLogin(plan).catch(fail)}>
          {connected ? "Reconnect" : "Connect"}
        </button>
      )}
    </div>
  );
}
