import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { agentKey, type Agent } from "../chat/types";
import { HubError, type ComputerActivityRow } from "../hub/client";
import {
  connectionsOf,
  SET_UP_BY_AGENT,
  setUpRequest,
  statusLine,
  type ConnectionsApi,
  type Pick,
  type ServicePicks,
} from "../hub/connections";
import { useDesk } from "../hub/store";
import { useUi } from "../shell/ui";
import { askAgent } from "../ui/askDesk";
import { useAgentConfigs } from "./agentBrain";
import { ago } from "./files";
import "../styles/connections.css";
import { choose, setAgentConnectors, writesOf, type Writes } from "./connectors";

/** How the agent's changes in its connectors go, as its access says. */
const WRITES_SAY: Record<Writes, (name: string) => string> = {
  ask: (name) => `${name} asks you before it changes anything in them.`,
  sends_ask: () => "Changes run on their own; anything that sends to people asks you first.",
  own: (name) => `${name} makes changes in them on its own, sends included.`,
};

/** The calls shown below the services. */
const SHOWN_CALLS = 20;

const localApi = (): ConnectionsApi | null => {
  const hub = useChat.getState().hubs.find((h) => h.local);
  return hub ? connectionsOf(hub) : null;
};

const plain = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Saving = { state: "idle" } | { state: "saving" } | { state: "saved" } | { state: "failed"; problem: string; retry: () => void };

/** Asks `agent` to set `service` up for itself, in its chat. */
const askToSetUp = (agent: Agent, service: string): boolean => {
  const asked = askAgent(agent.id, setUpRequest(service, "me"));
  if (asked) useUi.getState().closeSettings();
  return asked;
};

/** An agent's Connectors: per service, the person's connections it uses,
 *  whether each takes its changes, and which it uses when a request
 *  doesn't say. */
export function AgentConnectors({
  agent,
  api: given,
  ask = askToSetUp,
}: {
  agent: Agent;
  api?: ConnectionsApi;
  ask?: (agent: Agent, service: string) => boolean;
}) {
  const desk = useDesk((s) => s.hub);
  const key = agentKey(agent);
  const config = useAgentConfigs((s) => s.configs[key]);
  const put = useAgentConfigs((s) => s.put);
  const [api] = useState<ConnectionsApi | null>(() => given ?? localApi());
  const [services, setServices] = useState<ServicePicks[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState<Saving>({ state: "idle" });
  const [calls, setCalls] = useState<ComputerActivityRow[] | null>(null);
  const openSettings = useUi((u) => u.openSettings);
  const writes = useRef<Promise<unknown>>(Promise.resolve());

  const load = useCallback(async () => {
    if (!api) return;
    setProblem(null);
    try {
      setServices(await api.picks(agent.id));
    } catch (e) {
      setProblem(
        e instanceof HubError && e.status === 404
          ? "This version of Desk doesn’t offer connectors yet. Update Desk to use them."
          : "Desk couldn’t read your connections just now.",
      );
    }
  }, [api, agent.id]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (desk && config === undefined) void useAgentConfigs.getState().load(desk, agent);
  }, [desk, config, agent]);
  useEffect(() => {
    if (!desk) return;
    desk
      .computerActivity({ agent: agent.id, kind: "connector" })
      .then((page) => setCalls(page.rows.slice(0, SHOWN_CALLS)))
      .catch(() => setCalls(null));
  }, [desk, agent.id]);

  const writeMode: Writes = config === undefined ? "sends_ask" : writesOf(config);

  /** Writes one change at a time, in order. */
  const save = (work: () => Promise<void>) => {
    setSaving({ state: "saving" });
    const write = writes.current.then(work);
    writes.current = write.catch(() => {});
    write.then(
      () => setSaving({ state: "saved" }),
      (e: unknown) => setSaving({ state: "failed", problem: plain(e), retry: () => save(work) }),
    );
  };

  /** `s` with the agent using `picked`, `def` first. */
  const pick = (s: ServicePicks, picked: Pick[], def: string | null) =>
    save(async () => {
      if (!api) return;
      if (!s.several) {
        // Slack's one connection: on or off for the agent, as before.
        if (!desk) return;
        const reaching = (services ?? []).filter((x) => x.connections.length === 0 || x.connections.some((p) => p.picked)).map((x) => x.id);
        const toml = await setAgentConnectors(desk, agent.id, (b) => choose(b, s.id, picked.length ? "mine" : "off", { reaching, own: [] }));
        put(key, toml);
        await load();
        return;
      }
      const next = await api.setPicks(agent.id, {
        service: s.id,
        connections: picked.map((p) => ({ id: p.id, write: p.write })),
        default: picked.length === 0 ? null : (def ?? picked[0]!.id),
      });
      setServices(next);
    });

  return (
    <div className="agent-page">
      <div className="agent-settings">
        <section className="agent-section agent-connectors" aria-labelledby="connectors-head">
          <div className="ability-head">
            <h2 id="connectors-head">Connectors</h2>
          </div>
          <p className="small muted">
            Pick which connections {agent.name} works with. When it has more than one of a service, it asks which one if a request doesn’t make it
            clear, and says which it used. {WRITES_SAY[writeMode](agent.name)}
          </p>

          {problem && (
            <p className="small state-blocked" role="alert">
              {problem}{" "}
              <button type="button" className="link small" onClick={() => void load()}>
                Try again
              </button>
            </p>
          )}

          {services && (
            <div className="conn-picks" role="list" aria-label={`${agent.name}’s connectors`}>
              {services.map((s) => (
                <ServiceChoice
                  key={s.id}
                  agent={agent}
                  service={s}
                  onPick={(picked, def) => pick(s, picked, def)}
                  onAsk={SET_UP_BY_AGENT.has(s.id) ? () => ask(agent, s.name) : undefined}
                  onConnect={() => openSettings("connections")}
                />
              ))}
            </div>
          )}

          {saving.state !== "idle" && (
            <p
              className={`small ${saving.state === "failed" ? "state-blocked" : saving.state === "saved" ? "state-done" : "faint"}`}
              role="status"
            >
              {saving.state === "failed" ? (
                <>
                  {saving.problem}{" "}
                  <button type="button" className="link small" onClick={saving.retry}>
                    Try again
                  </button>
                </>
              ) : saving.state === "saving" ? (
                "Saving…"
              ) : (
                "Saved."
              )}
            </p>
          )}

          {calls && calls.length > 0 && (
            <section className="conn-sub" aria-label="Recent connector calls">
              <h3 className="field-label">Recent calls</h3>
              <ul className="conn-calls">
                {calls.map((x) => (
                  <li key={x.id}>
                    <span className="mono small">{x.tool}</span>
                    <span className="small">{x.doing}</span>
                    <span
                      className={`small ${x.outcome?.outcome === "refused" || x.outcome?.outcome === "declined" ? "state-blocked" : "faint"}`}
                    >
                      {x.outcome?.outcome?.replace("_", " ") ?? ""} · {ago(x.at)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </section>
      </div>
    </div>
  );
}

/** One service: a checkbox per connection the agent can use, whether each
 *  takes its changes, and its default. */
function ServiceChoice({
  agent,
  service: s,
  onPick,
  onAsk,
  onConnect,
}: {
  agent: Agent;
  service: ServicePicks;
  onPick: (picked: Pick[], def: string | null) => void;
  onAsk?: () => void;
  onConnect: () => void;
}) {
  const [changing, setChanging] = useState(false);
  const picked = s.connections.filter((p) => p.picked);
  const def = picked.find((p) => p.default) ?? picked[0] ?? null;

  if (s.connections.length === 0) {
    return (
      <section className="conn-pick conn-pick-empty" role="listitem" aria-label={`${s.name} for ${agent.name}`}>
        <div className="conn-pick-head">
          <b>{s.name}</b>
          <span className="small faint">no connection yet</span>
        </div>
        <div className="conn-pick-actions">
          {onAsk && (
            <button type="button" className="btn btn-sm btn-signal" onClick={onAsk}>
              Ask {agent.name} to set it up
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={onConnect}>
            Connect myself
          </button>
        </div>
      </section>
    );
  }

  const toggle = (p: Pick, on: boolean) => {
    const next = on ? [...picked, { ...p, picked: true }] : picked.filter((x) => x.id !== p.id);
    onPick(next, def && next.some((x) => x.id === def.id) ? def.id : null);
  };
  const setWrite = (p: Pick, write: boolean) => {
    // Without each its own, they take writes all together.
    const next = picked.map((x) => (x.id === p.id || !s.readOnlyEach ? { ...x, write } : x));
    onPick(next, def?.id ?? null);
  };

  return (
    <section className="conn-pick" role="listitem" aria-label={`${s.name} for ${agent.name}`}>
      <div className="conn-pick-head">
        <b>{s.name}</b>
        <span className="small muted">
          {picked.length} of {s.connections.length} on
        </span>
      </div>
      <div className="conn-pick-rows">
        {s.connections.map((p) => (
          <div key={p.id} className="conn-pick-row">
            <label className="conn-pick-label">
              <input type="checkbox" checked={p.picked} onChange={(e) => toggle(p, e.target.checked)} />
              <span className="conn-pick-name">
                <b>{p.name}</b>
                {(p.site ?? p.account) && <span className={p.site ? "mono conn-site" : "small muted"}>{(p.site ?? p.account)!.replace(/^https?:\/\//, "")}</span>}
                {p.level === "agent" && <span className="conn-tag">its own</span>}
              </span>
            </label>
            {p.status !== "connected" && <span className="small state-blocked">{statusLine(p)}</span>}
            {p.picked ? (
              <button
                type="button"
                className="link small conn-pick-write"
                aria-label={`${p.name}: ${p.write ? "read and write" : "read only"}. Change`}
                onClick={() => setWrite(p, !p.write)}
              >
                {p.write ? "read and write" : "read only"}
              </button>
            ) : (
              <span className="small faint">off</span>
            )}
          </div>
        ))}
      </div>
      {picked.length >= 2 && def && (
        <div className="small muted conn-pick-default">
          Default when it can’t tell:{" "}
          {changing ? (
            <select
              className="ability-select"
              aria-label={`${s.name} default`}
              data-autofocus
              value={def.id}
              onChange={(e) => {
                setChanging(false);
                onPick(picked, e.target.value);
              }}
              onBlur={() => setChanging(false)}
            >
              {picked.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <>
              <b className="conn-pick-default-name">{def.name}</b>{" "}
              <button type="button" className="link small" onClick={() => setChanging(true)}>
                change
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
