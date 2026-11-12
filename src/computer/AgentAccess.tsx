import { useCallback, useEffect, useState } from "react";
import { agentKey, type Agent } from "../chat/types";
import { HubError, type ComputerActivityRow, type ComputerGrant } from "../hub/client";
import { useDesk } from "../hub/store";
import { useAgentConfigs } from "../crew/agentBrain";
import { useUi } from "../shell/ui";
import { plainError } from "../ui/plainError";
import { tilde } from "../machines/folders";
import { backendHome, pickFolder } from "../platform";
import { ASKING, LEVELS, addFolder, askingOf, levelOf, setLevel, setWorksIn, worksInOf, type Asking, type Level } from "./access";
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
  const [grants, setGrants] = useState<ComputerGrant[] | null | "failed" | "old">(null);
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
      .catch((e: unknown) => setGrants(e instanceof HubError && e.status === 404 ? "old" : "failed"));
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

        <WorksIn agent={agent} />

        <section className="agent-section" aria-labelledby="computer-grants-head">
          <div className="ability-head">
            <h2 id="computer-grants-head">Allowed for {agent.name}</h2>
          </div>
          {grants === "old" ? (
            <p className="small faint">This version of Desk can’t do that yet. Update Desk to use it.</p>
          ) : grants === "failed" ? (
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

/** The folders the person gives the agent to work in beside its own: a repo
 *  cloned into a folder, say. Picked with the folder picker, listed, and
 *  removed one at a time; only the person changes them. */
function WorksIn({ agent }: { agent: Agent }) {
  const hub = useDesk((s) => s.hub);
  const key = agentKey(agent);
  const config = useAgentConfigs((s) => s.configs[key]);
  const [home, setHome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    backendHome()
      .then((h) => live && setHome(h))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const folders = config === undefined ? null : worksInOf(config);

  const write = async (change: (folders: string[]) => string[]) => {
    if (!hub) return;
    setBusy(true);
    setProblem(null);
    try {
      useAgentConfigs.getState().put(key, await setWorksIn(hub, agent.id, change));
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };
  const add = async () => {
    const picked = await pickFolder();
    if (!picked || !folders) return;
    const next = addFolder(folders, picked, home);
    if (next.problem) return setProblem(next.problem);
    void write((now) => addFolder(now, picked, home).folders);
  };

  return (
    <section className="agent-section" aria-labelledby="computer-works-in-head">
      <div className="ability-head">
        <h2 id="computer-works-in-head">Works in</h2>
        <button type="button" className="btn btn-ghost" disabled={folders === null || busy} onClick={() => void add()}>
          Add a folder…
        </button>
      </div>
      <p className="small faint">
        Folders or repos already cloned that {agent.name} reads and changes beside its own, at every level, and runs commands in at Full access. Coding work starts in the first. Deleting there asks you first.
      </p>
      {folders === null ? (
        <p className="small faint">Reading…</p>
      ) : folders.length === 0 ? (
        <p className="pane-empty small">Only its own folder. Add a folder or a cloned repo for it to work in.</p>
      ) : (
        <ul className="computer-list" aria-label={`Folders ${agent.name} works in`}>
          {folders.map((f, i) => (
            <li key={f} className="computer-row">
              <span className="computer-row-text">
                <span className="mono">{tilde(f, home)}</span>
                {i === 0 && <span className="small faint">Coding work starts here</span>}
              </span>
              <button type="button" className="btn btn-ghost" disabled={busy} aria-label={`Remove ${tilde(f, home)}`} onClick={() => void write((now) => now.filter((x) => x !== f))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
