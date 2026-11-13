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
import { allowWrites, choose, setAgentConnectors, todayOf, writesOf, type Writes } from "./connectors";

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

/** One change of an agent's connections of a service, made against the
 *  service as it is when its save runs. */
export type Change = { kind: "use"; id: string; on: boolean } | { kind: "write"; id: string; write: boolean } | { kind: "default"; id: string };

/** The connections of `s` the agent uses once `change` is made, and its
 *  default. */
export const applied = (s: ServicePicks, change: Change): { picked: Pick[]; def: string | null } => {
  const picked = s.connections.filter((p) => p.picked);
  const def = (picked.find((p) => p.default) ?? picked[0])?.id ?? null;
  switch (change.kind) {
    case "use": {
      const p = s.connections.find((x) => x.id === change.id);
      const next = change.on
        ? picked.some((x) => x.id === change.id) || !p
          ? picked
          : [...picked, { ...p, picked: true }]
        : picked.filter((x) => x.id !== change.id);
      return { picked: next, def: def && next.some((x) => x.id === def) ? def : null };
    }
    case "write":
      // Without each its own, they take writes all together.
      return { picked: picked.map((x) => (x.id === change.id || !s.readOnlyEach ? { ...x, write: change.write } : x)), def };
    case "default":
      return { picked, def: picked.some((x) => x.id === change.id) ? change.id : def };
  }
};

/** `s` as it will be once `changes` are saved: what it shows meanwhile,
 *  so a second click works from the first. */
export const pending = (s: ServicePicks, changes: readonly Change[]): ServicePicks =>
  changes.reduce((s, c) => {
    if (!s.several) {
      return {
        ...s,
        connections: s.connections.map((p) =>
          p.id !== c.id ? p : c.kind === "use" ? { ...p, picked: c.on } : c.kind === "write" ? { ...p, write: c.write } : p,
        ),
      };
    }
    const { picked, def } = applied(s, c);
    const first = def ?? picked[0]?.id ?? null;
    return {
      ...s,
      connections: s.connections.map((p) => {
        const q = picked.find((x) => x.id === p.id);
        return { ...p, picked: !!q, write: q?.write ?? p.write, default: !!q && first === p.id };
      }),
    };
  }, s);

const same = (a: Change, b: Change): boolean => JSON.stringify(a) === JSON.stringify(b);

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
  /** The services as the hub last said, kept as each save comes back:
   *  a queued save works from these, never from what was on screen when
   *  it was clicked. */
  const latest = useRef<ServicePicks[] | null>(null);
  /** Changes clicked and not yet saved, in order: shown as made. */
  const [queued, setQueued] = useState<{ n: number; service: string; change: Change }[]>([]);
  const queue = useRef<{ n: number; service: string; change: Change }[]>([]);
  const counter = useRef(0);
  const inFlight = useRef(0);
  /** The first save that failed and isn't saved since. */
  const failure = useRef<{ service: string; change: Change; problem: string } | null>(null);
  /** The agent whose connections these are, while shown: a save still
   *  running once this has gone (another agent is keyed afresh) shows
   *  nothing. */
  const shownFor = useRef(agent.id);
  useEffect(() => {
    shownFor.current = agent.id;
    return () => {
      shownFor.current = "";
    };
  }, [agent.id]);

  const load = useCallback(async () => {
    if (!api) return;
    setProblem(null);
    try {
      const got = await api.picks(agent.id);
      if (shownFor.current !== agent.id) return;
      latest.current = got;
      setServices(got);
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

  const said = (next: ServicePicks[], forAgent: string) => {
    if (shownFor.current !== forAgent) return;
    latest.current = next;
    setServices(next);
  };

  /** What the status says once a save ends: saving while any is left,
   *  else the first failure not saved since, else saved. */
  const settle = () => {
    const f = failure.current;
    setSaving(
      inFlight.current > 0
        ? { state: "saving" }
        : f
          ? { state: "failed", problem: f.problem, retry: () => make(f.service, f.change) }
          : { state: "saved" },
    );
  };

  /** Makes `change` to service `id`, one save at a time, in order, each
   *  from the services as they are when its turn comes. */
  const make = (id: string, change: Change) => {
    const n = ++counter.current;
    const forAgent = agent.id;
    queue.current = [...queue.current, { n, service: id, change }];
    setQueued(queue.current);
    inFlight.current += 1;
    setSaving({ state: "saving" });
    const work = async () => {
      try {
        await write(id, change, forAgent);
      } finally {
        if (shownFor.current === forAgent) {
          queue.current = queue.current.filter((q) => q.n !== n);
          setQueued(queue.current);
        }
      }
    };
    const run = writes.current.then(work);
    writes.current = run.catch(() => {});
    run.then(
      () => {
        if (shownFor.current !== forAgent) return;
        // Saved since: the same change, tried again or clicked again.
        if (failure.current && failure.current.service === id && same(failure.current.change, change)) failure.current = null;
        inFlight.current -= 1;
        settle();
      },
      (e: unknown) => {
        if (shownFor.current !== forAgent) return;
        failure.current ??= { service: id, change, problem: plain(e) };
        inFlight.current -= 1;
        settle();
      },
    );
  };

  const write = async (id: string, change: Change, forAgent: string) => {
    if (!api) return;
    const s = (latest.current ?? []).find((x) => x.id === id);
    if (!s) return;
    if (!s.several) {
      // Slack's one connection: on or off for the agent, and whether it
      // takes changes, in its own settings.
      if (!desk) return;
      const today = todayOf(await api.list(), forAgent);
      const p = s.connections.find((x) => x.id === change.id);
      const toml = await setAgentConnectors(desk, forAgent, (b) =>
        change.kind === "use"
          ? choose(b, s.id, change.on ? (p?.level === "agent" ? "own" : "mine") : "off", today)
          : change.kind === "write"
            ? allowWrites(b, s.id, change.write, today)
            : b,
      );
      if (shownFor.current === forAgent) put(key, toml);
      said(await api.picks(forAgent), forAgent);
      return;
    }
    const { picked, def } = applied(s, change);
    said(
      await api.setPicks(forAgent, {
        service: s.id,
        connections: picked.map((p) => ({ id: p.id, write: p.write })),
        default: picked.length === 0 ? null : (def ?? picked[0]!.id),
      }),
      forAgent,
    );
  };

  const shown = services?.map((s) => {
    const mine = queued.filter((q) => q.service === s.id).map((q) => q.change);
    return mine.length ? pending(s, mine) : s;
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

          {shown && (
            <div className="conn-picks" role="list" aria-label={`${agent.name}’s connectors`}>
              {shown.map((s) => (
                <ServiceChoice
                  key={s.id}
                  agent={agent}
                  service={s}
                  onChange={(c) => make(s.id, c)}
                  onAsk={SET_UP_BY_AGENT.has(s.id) ? () => ask(agent, s.name) : undefined}
                  onConnect={() => openSettings("connections")}
                />
              ))}
            </div>
          )}

          {/* There from the first, so its first word is read out. */}
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
            ) : saving.state === "saved" ? (
              "Saved."
            ) : null}
          </p>

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
  onChange,
  onAsk,
  onConnect,
}: {
  agent: Agent;
  service: ServicePicks;
  onChange: (change: Change) => void;
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
              <input type="checkbox" checked={p.picked} onChange={(e) => onChange({ kind: "use", id: p.id, on: e.target.checked })} />
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
                onClick={() => onChange({ kind: "write", id: p.id, write: !p.write })}
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
                onChange({ kind: "default", id: e.target.value });
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
