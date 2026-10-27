import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import { applyPlan, pickPlan, PLAN_LOGIN, type Plan } from "../crew/local";
import { useDesk } from "../hub/store";
import { PlanLogin } from "./PlanLogin";
import { useSettings } from "./store";

const VOICE_KEYS = [
  { path: "speech/openai/api_key", label: "OpenAI key", use: "for GPT-Live voice" },
  { path: "speech/gemini/api_key", label: "Gemini key", use: "for Gemini Live voice" },
] as const;

/** The plans your agents on this Mac run on, and the keys voice needs. */
export function Plans() {
  const { hub, fail } = useDesk();
  const roster = useChat((s) => s.roster);
  const chosen = useSettings((s) => s.plan) as Plan | null;
  const setSettings = useSettings((s) => s.set);
  const [have, setHave] = useState<string[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);

  const refresh = () => hub?.vaultPaths().then(setHave).catch(fail);
  useEffect(() => {
    void refresh();
  }, [hub]); // eslint-disable-line react-hooks/exhaustive-deps

  const plan = pickPlan(chosen, have);
  const localAgents = roster.filter((a) => a.hubId === "local").map((a) => a.id);

  const use = async (next: Plan) => {
    if (!hub) return;
    setSettings({ plan: next });
    try {
      await applyPlan(hub, localAgents, next);
      setNote(`Your agents now use your ${next === "claude" ? "Claude" : "ChatGPT"} plan.`);
    } catch (e) {
      fail(e);
    }
  };

  const save = async (path: string, value: string, done: string) => {
    if (!hub || !value.trim()) return;
    try {
      await hub.saveVault(path, value.trim());
      await refresh();
      setNote(done);
    } catch (e) {
      fail(e);
    }
  };

  const connected = async (p: Plan) => {
    const paths = (await hub?.vaultPaths()) ?? [];
    setHave(paths);
    if (!chosen && pickPlan(null, paths) === p) await use(p);
  };

  return (
    <section className="settings-pane" aria-label="Plans">
      <h1 className="display-lg">Plans</h1>
      <p className="muted">Your agents on this Mac work on your own Claude or ChatGPT plan. Connect one, or both and choose.</p>

      <div className="field">
        <span>Your agents use</span>
        <div className="seg" role="radiogroup" aria-label="Plan">
          {(["claude", "chatgpt"] as const).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={plan === p} onClick={() => void use(p)}>
              {p === "claude" ? "Claude plan" : "ChatGPT plan"}
            </button>
          ))}
        </div>
      </div>

      <PlanLogin plan="claude" connected={have.includes(PLAN_LOGIN.claude)} onConnected={() => void connected("claude")} />
      <PlanLogin plan="chatgpt" connected={have.includes(PLAN_LOGIN.chatgpt)} onConnected={() => void connected("chatgpt")} />

      <h2 className="display-md">Voice keys</h2>
      <p className="muted small">Only needed for the cloud voice engines under Calls and voice.</p>
      {VOICE_KEYS.map((k) => (
        <div key={k.path} className="hub-row plan-row">
          <span className="hub-name">
            <b className="display">{k.label}</b>
            <span className="small muted">{have.includes(k.path) ? "Saved" : k.use}</span>
          </span>
          <span className="field-row plan-field">
            <input
              type="password"
              value={keys[k.path] ?? ""}
              autoComplete="off"
              onChange={(e) => setKeys((s) => ({ ...s, [k.path]: e.target.value }))}
            />
            <button
              type="button"
              className="btn"
              disabled={!(keys[k.path] ?? "").trim()}
              onClick={() =>
                void save(k.path, keys[k.path] ?? "", `${k.label} saved.`).then(() => setKeys((s) => ({ ...s, [k.path]: "" })))
              }
            >
              Save
            </button>
          </span>
        </div>
      ))}
      {note && <p className="state-done small">{note}</p>}
    </section>
  );
}
