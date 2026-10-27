import { useEffect, useState } from "react";
import { useDesk } from "../hub/store";
import { codexLogin } from "../platform";

const CLAUDE = "claude_code/oauth_token";
const CHATGPT = "codex/auth_json";

/** The plans the local hub's agents run on: stored once, hub-wide, in the
 *  local hub's vault. */
export function Plans() {
  const { hub, fail } = useDesk();
  const [have, setHave] = useState<string[]>([]);
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const refresh = () => hub?.vaultPaths().then(setHave).catch(fail);
  useEffect(() => {
    refresh();
  }, [hub]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (path: string, value: string, label: string) => {
    if (!hub) return;
    try {
      await hub.saveVault(path, value.trim());
      setSaved(label);
      setToken("");
      await refresh();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <section className="settings-pane" aria-label="Plans">
      <h1 className="display-lg">Plans</h1>
      <p className="muted">
        Agents on your local hub work on your own plans through the real <code>claude</code> and <code>codex</code> command-line
        tools. Connect each once.
      </p>
      <div className="hub-row plan-row">
        <span className="hub-name">
          <b className="display">Claude</b>
          <span className="small muted">
            {have.includes(CLAUDE) ? "Connected" : "In a terminal, run claude setup-token and paste the token it prints."}
          </span>
        </span>
        <span className="field-row plan-field">
          <input
            type="password"
            value={token}
            placeholder="sk-ant-oat…"
            autoComplete="off"
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="button" className="btn btn-signal" disabled={!token.trim()} onClick={() => save(CLAUDE, token, "Claude")}>
            {have.includes(CLAUDE) ? "Replace" : "Connect"}
          </button>
        </span>
      </div>
      <div className="hub-row plan-row">
        <span className="hub-name">
          <b className="display">ChatGPT</b>
          <span className="small muted">
            {have.includes(CHATGPT) ? "Connected" : "Uses the login of the codex command on this Mac."}
          </span>
        </span>
        <button
          type="button"
          className="btn btn-signal"
          onClick={() =>
            codexLogin()
              .then((auth) => save(CHATGPT, auth, "ChatGPT"))
              .catch(fail)
          }
        >
          {have.includes(CHATGPT) ? "Use it again" : "Use this Mac’s Codex login"}
        </button>
      </div>
      {saved && <p className="state-done small">{saved} is connected.</p>}
    </section>
  );
}
