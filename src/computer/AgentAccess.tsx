import { useCallback, useEffect, useState } from "react";
import { agentKey, type Agent } from "../chat/types";
import type { ComputerActivityRow, ComputerGrant } from "../hub/client";
import { useDesk } from "../hub/store";
import { useAgentConfigs } from "../crew/agentBrain";
import { useUi } from "../shell/ui";
import { plainError } from "../ui/plainError";
import { ASKING, LEVELS, askingOf, levelOf, setLevel, type Asking, type Level } from "./access";
import { ActivityList, EMPTY_ACTIVITY, GrantList } from "./Lists";
import "../styles/computer.css";

/** How many of the agent's own rows its tab shows. */
const RECENT = 20;

/** A local agent's "This computer" tab: how far it reaches, what is always
 *  allowed for it, and what it did here lately. */
export function AgentAccess({ agent }: { agent: Agent }) {
  const hub = useDesk((s) => s.hub);
  const key = agentKey(agent);
  const config = useAgentConfigs((s) => s.configs[key]);
  const [saving, setSaving] = useState<Level | Asking | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [grants, setGrants] = useState<ComputerGrant[] | null | "failed">(null);
  const [rows, setRows] = useState<ComputerActivityRow[] | null | "failed">(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (hub) void useAgentConfigs.getState().load(hub, agent);
  }, [hub, agent.id]);

  const reload = useCallback(() => {
    if (!hub) return;
    hub
      .computerGrants(agent.id)
      .then(setGrants)
      .catch(() => setGrants("failed"));
    hub
      .computerActivity({ agent: agent.id })
      .then((p) => setRows(p.rows.slice(0, RECENT)))
      .catch(() => setRows("failed"));
  }, [hub, agent.id]);
  useEffect(reload, [reload]);

  const level = config === undefined ? null : levelOf(config);
  const asking = config === undefined ? null : askingOf(config);
  const save = async (next: Level, asks?: Asking) => {
    if (!hub || saving) return;
    setSaving(asks ?? next);
    setProblem(null);
    try {
      useAgentConfigs.getState().put(key, await setLevel(hub, agent.id, next, asks));
    } catch (e) {
      setProblem(plainError(e));
    }
    setSaving(null);
  };
  const choose = (next: Level) => {
    if (next !== level) void save(next);
  };
  const chooseAsking = (next: Asking) => {
    if (next !== asking) void save("full", next);
  };
  const revoke = async (g: ComputerGrant) => {
    if (!hub) return;
    setBusy(g.id);
    try {
      await (g.session_id ? hub.forgetSession(g.session_id) : hub.revokeGrant(g.id));
      reload();
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(null);
  };
  const names = { [agent.id]: agent.name };

  return (
    <div className="agent-page">
      <div className="agent-settings">
        <section className="agent-section" aria-labelledby="computer-level-head">
          <div className="ability-head">
            <h2 id="computer-level-head">How far {agent.name} reaches here</h2>
          </div>
          <div className="ability-card">
            <div className="pick-list" role="radiogroup" aria-label={`How far ${agent.name} reaches on this computer`}>
              {LEVELS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  className="pick"
                  aria-checked={level === l.id}
                  disabled={level === null || saving !== null}
                  onClick={() => choose(l.id)}
                >
                  <span className="radio-ring" aria-hidden="true" />
                  <span className="pick-text">
                    <b>{l.title}</b>
                    <span>{l.line}</span>
                  </span>
                </button>
              ))}
            </div>
            {level !== null && level !== "full" && (
              <p className="ability-note small">Commands are off at this level on this computer.</p>
            )}
            {level === "full" && (
              <>
                <div className="pick-list" role="radiogroup" aria-label={`What ${agent.name} asks you about first`}>
                  {ASKING.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      role="radio"
                      className="pick"
                      aria-checked={asking === a.id}
                      disabled={saving !== null}
                      onClick={() => chooseAsking(a.id)}
                    >
                      <span className="radio-ring" aria-hidden="true" />
                      <span className="pick-text">
                        <b>{a.title}</b>
                        <span>{a.line}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="ability-note small">Scheduled jobs and other runs with nobody to ask carry on as before.</p>
              </>
            )}
            {problem && (
              <p className="small state-blocked" role="alert">
                {problem}
              </p>
            )}
          </div>
        </section>

        <section className="agent-section" aria-labelledby="computer-grants-head">
          <div className="ability-head">
            <h2 id="computer-grants-head">Allowed for {agent.name}</h2>
          </div>
          {grants === "failed" ? (
            <p className="small state-blocked">Couldn’t read what’s allowed just now.</p>
          ) : grants === null ? (
            <p className="small faint">Reading…</p>
          ) : grants.length === 0 ? (
            <p className="pane-empty small">Nothing yet. Choose “Always allow” on a request and it shows here.</p>
          ) : (
            <GrantList grants={grants} names={names} onRevoke={(g) => void revoke(g)} busy={busy} />
          )}
        </section>

        <section className="agent-section" aria-labelledby="computer-activity-head">
          <div className="ability-head">
            <h2 id="computer-activity-head">Recent activity</h2>
            <button type="button" className="link small" onClick={() => useUi.getState().openSettings("computer")}>
              See all
            </button>
          </div>
          {rows === "failed" ? (
            <p className="small state-blocked">Couldn’t read what {agent.name} did here just now.</p>
          ) : rows === null ? (
            <p className="small faint">Reading…</p>
          ) : rows.length === 0 ? (
            <p className="pane-empty small">{EMPTY_ACTIVITY}</p>
          ) : (
            <ActivityList rows={rows} names={names} />
          )}
        </section>
      </div>
    </div>
  );
}
