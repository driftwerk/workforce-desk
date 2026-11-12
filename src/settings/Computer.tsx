import { useCallback, useEffect, useState } from "react";
import { AgentMark } from "../ui/Mark";
import { useChat } from "../chat/store";
import { agentKey, type Agent } from "../chat/types";
import { askingOf, levelLabel, levelOf, KINDS } from "../computer/access";
import { ActivityList, EMPTY_ACTIVITY, GrantList } from "../computer/Lists";
import { useAgentConfigs } from "../crew/agentBrain";
import { HubError, type ComputerActivityPage, type ComputerGrant, type DiskAccess } from "../hub/client";
import { useDesk } from "../hub/store";
import { openAgent } from "../rooms/AgentPanel";
import { useUi } from "../shell/ui";
import { plainError } from "../ui/plainError";
import { openPane, useRecheckOnFocus } from "../ui/privacy";
import "../styles/computer.css";

/** Settings → This computer: whether agents may use it at all, how far each
 *  local agent reaches, what is always allowed, and what they did here. */
export function Computer() {
  const hub = useDesk((s) => s.hub);
  const hubs = useChat((s) => s.hubs);
  const roster = useChat((s) => s.roster);
  const configs = useAgentConfigs((s) => s.configs);
  const localHub = hubs.find((h) => h.local);
  const agents: Agent[] = roster.filter((a) => a.hubId === localHub?.id);
  const names = Object.fromEntries(agents.map((a) => [a.id, a.name]));

  const [stopped, setStopped] = useState<boolean | null | "failed" | "old">(null);
  const [disk, setDisk] = useState<DiskAccess | null>(null);
  const [grants, setGrants] = useState<ComputerGrant[] | null | "failed">(null);
  const [page, setPage] = useState<ComputerActivityPage | null | "failed">(null);
  const [agentFilter, setAgentFilter] = useState("");
  const [kind, setKind] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!hub) return;
    for (const a of agents) void useAgentConfigs.getState().load(hub, a);
  }, [hub, agents.map((a) => a.id).join()]);

  const reload = useCallback(() => {
    if (!hub) return;
    hub
      .computerAccess()
      .then((a) => setStopped(a.stopped))
      .catch((e: unknown) => setStopped(e instanceof HubError && e.status === 404 ? "old" : "failed"));
    hub
      .diskAccess()
      .then(setDisk)
      .catch(() => setDisk("unknown"));
    hub
      .computerGrants()
      .then(setGrants)
      .catch(() => setGrants("failed"));
  }, [hub]);
  useEffect(reload, [reload]);
  // Back from System Settings: read Full Disk Access again, so the banner
  // goes once it's on.
  useRecheckOnFocus("fullDiskAccess", disk === "missing" && !!hub, () => undefined, async () => {
    if (!hub) return false;
    // The hub not answering says nothing new: the card stays as it was.
    const now = await hub.diskAccess().catch(() => null);
    if (now === null || now === "unknown") return false;
    setDisk(now);
    return now === "granted";
  });
  useEffect(() => {
    if (!hub) return;
    hub
      .computerActivity({ agent: agentFilter || undefined })
      .then(setPage)
      .catch(() => setPage("failed"));
  }, [hub, agentFilter]);

  const setSwitch = async (next: boolean) => {
    if (!hub) return;
    setProblem(null);
    try {
      setStopped((await hub.setComputerStopped(next)).stopped);
    } catch (e) {
      setProblem(plainError(e));
    }
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
  const change = (a: Agent) => {
    useUi.getState().setAgentTab(agentKey(a), "access");
    useUi.getState().closeSettings();
    openAgent(agentKey(a));
  };

  const reaching = agents.some((a) => {
    const c = configs[agentKey(a)];
    return c !== undefined && levelOf(c) !== "own_folder";
  });
  const kinds = KINDS.find((k) => k.id === kind)?.kinds ?? [];
  const rows = page && page !== "failed" ? page.rows.filter((r) => kinds.length === 0 || kinds.includes(r.kind)) : [];
  const standing = grants && grants !== "failed" ? grants.filter((g) => !g.session_id) : [];
  const session = grants && grants !== "failed" ? grants.filter((g) => g.session_id) : [];

  return (
    <section className="settings-pane" aria-label="This computer">
      <h1 className="display-lg">This computer</h1>
      <p className="muted small">
        What your agents may read, change and run on this computer. At Full access an agent asks you only before what can’t be undone, unless you let it do anything.
      </p>
      {!hub ? (
        <p className="faint small">Desk isn’t ready yet.</p>
      ) : stopped === "old" ? (
        <p className="faint small">This version of Desk can’t do that yet. Update Desk to use it.</p>
      ) : (
        <>
          {stopped === "failed" ? (
            <p className="state-blocked small">Desk couldn’t read this computer’s settings just now.</p>
          ) : stopped === true ? (
            <div className="computer-banner" role="status">
              <span>Stopped. No agent can read, change or run anything here.</span>
              <button type="button" className="btn btn-signal" onClick={() => void setSwitch(false)}>
                Allow again
              </button>
            </div>
          ) : (
            <div className="toggle-row">
              <input
                id="computer-switch"
                type="checkbox"
                checked={stopped === false}
                disabled={stopped === null}
                onChange={(e) => void setSwitch(!e.target.checked)}
              />
              <span>
                <label htmlFor="computer-switch">Agents can use this computer</label>
                <span className="small muted">Off, nothing an agent asks to read, change or run here goes ahead.</span>
              </span>
              <button type="button" className="btn btn-danger" disabled={stopped === null} onClick={() => void setSwitch(true)}>
                Stop all access now
              </button>
            </div>
          )}
          {problem && (
            <p className="small state-blocked" role="alert">
              {problem}
            </p>
          )}

          {disk === "missing" && reaching && (
            <div className="computer-banner" aria-label="Full Disk Access">
              <span>macOS keeps Mail, Messages, Safari and other apps’ files from your agents until you allow Full Disk Access.</span>
              <button type="button" className="btn btn-signal" onClick={() => void openPane("fullDiskAccess")}>
                Grant Full Disk Access
              </button>
            </div>
          )}
          {disk === "granted" && reaching && <p className="small state-done">Full Disk Access is on.</p>}

          <h2 className="field-label">Agents</h2>
          {agents.length === 0 ? (
            <p className="pane-empty small">No agents on this computer yet.</p>
          ) : (
            <ul className="computer-list" aria-label="Agents">
              {agents.map((a) => {
                const c = configs[agentKey(a)];
                return (
                  <li key={a.id} className="computer-row">
                    <AgentMark agent={agentKey(a)} name={a.name} />
                    <span className="computer-row-text">
                      <span>{a.name}</span>
                      <span className="small muted">{c === undefined ? "Reading…" : levelLabel(levelOf(c), askingOf(c))}</span>
                    </span>
                    <button type="button" className="btn btn-ghost" onClick={() => change(a)}>
                      Change…
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <h2 className="field-label">Always allowed</h2>
          {grants === "failed" ? (
            <p className="small state-blocked">Couldn’t read what’s allowed just now.</p>
          ) : grants === null ? (
            <p className="small faint">Reading…</p>
          ) : standing.length === 0 ? (
            <p className="pane-empty small">Nothing yet. Choose “Always allow” on a request and it shows here.</p>
          ) : (
            <GrantList grants={standing} names={names} onRevoke={(g) => void revoke(g)} busy={busy} />
          )}
          {session.length > 0 && (
            <>
              <h3 className="field-label">This session</h3>
              <GrantList grants={session} names={names} onRevoke={(g) => void revoke(g)} busy={busy} />
            </>
          )}

          <h2 className="field-label">Activity</h2>
          <div className="computer-filters">
            <select aria-label="Agent" className="ability-select" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
              <option value="">Every agent</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <div className="effort-seg" role="radiogroup" aria-label="Kind">
              {KINDS.map((k) => (
                <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} onClick={() => setKind(k.id)}>
                  {k.label}
                </button>
              ))}
            </div>
          </div>
          {page === "failed" ? (
            <p className="small state-blocked">Couldn’t read the activity just now.</p>
          ) : page === null ? (
            <p className="small faint">Reading…</p>
          ) : rows.length === 0 ? (
            <p className="pane-empty small">{EMPTY_ACTIVITY}</p>
          ) : (
            <ActivityList rows={rows} names={names} />
          )}
        </>
      )}
    </section>
  );
}
