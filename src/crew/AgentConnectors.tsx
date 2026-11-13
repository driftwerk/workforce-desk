import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { agentKey, type Agent } from "../chat/types";
import { HubError, type ComputerActivityRow } from "../hub/client";
import {
  connectionsOf,
  mine,
  statusLine,
  type ConnectionsApi,
  type Connector,
  type Listing,
} from "../hub/connections";
import { useDesk } from "../hub/store";
import { Connect } from "../settings/Connections";
import { useUi } from "../shell/ui";
import { radioKeys } from "../ui/Dialog";
import { useAgentConfigs } from "./agentBrain";
import { ago } from "./files";
import "../styles/connections.css";
import {
  allowWrites,
  writesOf,
  type Writes,
  bindingOf,
  choose,
  setAgentConnectors,
  throughOf,
  todayOf,
  type Binding,
  type Through,
  type Today,
} from "./connectors";

/** How the agent's changes in its connectors go, as its access says. */
const WRITES_SAY: Record<Writes, (name: string) => string> = {
  ask: (name) => `${name} asks you before it changes anything in them.`,
  sends_ask: () => "Changes run on their own; anything that sends to people asks you first.",
  own: (name) => `${name} makes changes in them on its own, sends included.`,
};

const WRITES_ROW: Record<Writes, string> = {
  ask: "asks before changes",
  sends_ask: "sends to people ask first",
  own: "works on its own",
};

/** The calls shown below the rows. */
const SHOWN_CALLS = 20;

const THROUGH: { id: Through; name: string }[] = [
  { id: "off", name: "Off" },
  { id: "mine", name: "My connection" },
  { id: "own", name: "Its own connection" },
];

const WRITES: { id: "read" | "write"; name: string }[] = [
  { id: "read", name: "Read only" },
  { id: "write", name: "Read and write" },
];

const localApi = (): ConnectionsApi | null => {
  const hub = useChat.getState().hubs.find((h) => h.local);
  return hub ? connectionsOf(hub) : null;
};

const plain = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

type Saving =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved" }
  | { state: "failed"; problem: string };

/** An agent's Connectors: which services reach it, through whose
 *  connection, and whether it may change things there. */
export function AgentConnectors({
  agent,
  api: given,
}: {
  agent: Agent;
  api?: ConnectionsApi;
}) {
  const desk = useDesk((s) => s.hub);
  const key = agentKey(agent);
  const config = useAgentConfigs((s) => s.configs[key]);
  const put = useAgentConfigs((s) => s.put);
  const [api] = useState<ConnectionsApi | null>(() => given ?? localApi());
  const [listing, setListing] = useState<Listing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState<Saving>({ state: "idle" });
  const [owning, setOwning] = useState<string | null>(null);
  const [calls, setCalls] = useState<ComputerActivityRow[] | null>(null);
  const openSettings = useUi((u) => u.openSettings);
  const writes = useRef<Promise<unknown>>(Promise.resolve());

  const load = useCallback(async () => {
    if (!api) return;
    setProblem(null);
    try {
      setListing(await api.list());
    } catch (e) {
      setProblem(
        e instanceof HubError && e.status === 404
          ? "This version of Desk doesn’t offer connectors yet. Update Desk to use them."
          : "Desk couldn’t read your connections just now.",
      );
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (desk && config === undefined)
      void useAgentConfigs.getState().load(desk, agent);
  }, [desk, config, agent]);
  useEffect(() => {
    if (!desk) return;
    desk
      .computerActivity({ agent: agent.id, kind: "connector" })
      .then((page) => setCalls(page.rows.slice(0, SHOWN_CALLS)))
      .catch(() => setCalls(null));
  }, [desk, agent.id]);

  const list = listing?.connectors ?? null;
  const binding: Binding | null =
    config === undefined ? null : bindingOf(config);
  const writeMode: Writes = config === undefined ? "sends_ask" : writesOf(config);

  /** Every connector reaching the agent today, as a first choice must keep
   *  them: the catalog's, and every other adapter the hub has. */
  const today = (): Today => todayOf(listing, agent.id);

  const update = (change: (b: Binding) => Binding) => {
    if (!desk) return;
    setSaving({ state: "saving" });
    const write = writes.current.then(() =>
      setAgentConnectors(desk, agent.id, change),
    );
    writes.current = write.catch(() => {});
    write.then(
      (toml) => {
        put(key, toml);
        setSaving({ state: "saved" });
      },
      (e: unknown) => setSaving({ state: "failed", problem: plain(e) }),
    );
  };

  const reach = today();
  const ownFor = (c: Connector) =>
    c.connections.find((x) => x.level === "agent" && x.agent === agent.id);
  const nothing =
    list !== null && list.every((c) => c.connections.length === 0);

  return (
    <div className="agent-page">
      <div className="agent-settings">
        <section
          className="agent-section agent-connectors"
          aria-labelledby="connectors-head"
        >
          <div className="ability-head">
            <h2 id="connectors-head">Connectors</h2>
          </div>
          <p className="small muted">
            The services {agent.name} works in. It only gets the ones you turn
            on here.{" "}
            {WRITES_SAY[writeMode](agent.name)}
          </p>

          {problem && (
            <p className="small state-blocked" role="alert">
              {problem}{" "}
              <button
                type="button"
                className="link small"
                onClick={() => void load()}
              >
                Try again
              </button>
            </p>
          )}

          {nothing && (
            <div className="setting-card">
              <span className="card-text">
                <b>No connections yet</b>
                <span>
                  Connect a service once in Settings, then turn it on here for{" "}
                  {agent.name}.
                </span>
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => openSettings("connections")}
              >
                Open Connections
              </button>
            </div>
          )}

          {binding && binding.enabled === null && list && !nothing && (
            <p className="small faint" role="note">
              {agent.name} has every connector, as before you chose any.
              Choosing one below gives it only the ones you pick.
            </p>
          )}

          {list && binding && !nothing && (
            <div
              className="ability-card"
              role="list"
              aria-label={`${agent.name}’s connectors`}
            >
              {list.map((c) => (
                <ConnectorChoice
                  key={c.id}
                  agent={agent}
                  connector={c}
                  binding={binding}
                  writes={writeMode}
                  hasOwn={!!ownFor(c)}
                  onThrough={(through) => {
                    if (through === "own" && !ownFor(c)) {
                      setOwning(c.id);
                      return;
                    }
                    update((b) => choose(b, c.id, through, reach));
                  }}
                  onWrites={(w) =>
                    update((b) => allowWrites(b, c.id, w, reach))
                  }
                  onConnectFirst={() => openSettings("connections")}
                />
              ))}
            </div>
          )}

          {owning && api && list && (
            <OwnConnection
              api={api}
              agent={agent}
              connector={list.find((c) => c.id === owning)!}
              onDone={async () => {
                const id = owning;
                setOwning(null);
                await load();
                update((b) => choose(b, id, "own", reach));
              }}
              onCancel={() => setOwning(null)}
            />
          )}

          {saving.state !== "idle" && (
            <p
              className={`small ${saving.state === "failed" ? "state-blocked" : saving.state === "saved" ? "state-done" : "faint"}`}
              role="status"
            >
              {saving.state === "failed"
                ? saving.problem
                : saving.state === "saving"
                  ? "Saving…"
                  : "Saved."}
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
                      {x.outcome?.outcome?.replace("_", " ") ?? ""} ·{" "}
                      {ago(x.at)}
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

function ConnectorChoice({
  agent,
  connector: c,
  binding,
  writes,
  hasOwn,
  onThrough,
  onWrites,
  onConnectFirst,
}: {
  agent: Agent;
  connector: Connector;
  binding: Binding;
  writes: Writes;
  hasOwn: boolean;
  onThrough: (t: Through) => void;
  onWrites: (writes: boolean) => void;
  onConnectFirst: () => void;
}) {
  const ids = useId();
  const all = mine(c);
  const through = throughOf(binding, c.id);
  const current = THROUGH.findIndex((t) => t.id === through);
  const readOnly = binding.readOnly.includes(c.id);
  const writeIdx = readOnly ? 0 : 1;
  const disabled = (t: Through) => t === "mine" && !all;

  const status = (() => {
    if (through === "own")
      return hasOwn
        ? `${c.name} for ${agent.name} only`
        : `${agent.name}’s own ${c.name} isn’t connected`;
    if (through === "mine") return all ? statusLine(all) : `Not connected`;
    return all ? statusLine(all) : "Not connected";
  })();

  return (
    <div
      className="ability-row ability-row-center conn-choice"
      role="listitem"
      aria-label={c.name}
    >
      <span className="ability-text">
        <b id={`${ids}-name`}>{c.name}</b>
        <span className="ability-sub">
          {status}
          {through !== "off" &&
            ` · ${readOnly ? "reads only" : WRITES_ROW[writes]}`}
        </span>
        {!all && through !== "own" && (
          <button
            type="button"
            className="link small conn-first"
            onClick={onConnectFirst}
          >
            Connect {c.name} first
          </button>
        )}
      </span>
      <span className="conn-segs">
        <div
          className="seg ability-seg"
          role="radiogroup"
          aria-labelledby={`${ids}-name`}
        >
          {THROUGH.map((t, i) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={through === t.id}
              tabIndex={i === current ? 0 : -1}
              disabled={disabled(t.id)}
              title={disabled(t.id) ? `Connect ${c.name} first` : undefined}
              onClick={() => through !== t.id && onThrough(t.id)}
              onKeyDown={(e) =>
                radioKeys(
                  e,
                  THROUGH,
                  current,
                  (next) =>
                    next.id !== through &&
                    !disabled(next.id) &&
                    onThrough(next.id),
                )
              }
            >
              {t.name}
            </button>
          ))}
        </div>
        {through !== "off" && (
          <div
            className="seg ability-seg"
            role="radiogroup"
            aria-label={`What ${agent.name} may do in ${c.name}`}
          >
            {WRITES.map((w, i) => (
              <button
                key={w.id}
                type="button"
                role="radio"
                aria-checked={i === writeIdx}
                tabIndex={i === writeIdx ? 0 : -1}
                onClick={() => i !== writeIdx && onWrites(w.id === "write")}
                onKeyDown={(e) =>
                  radioKeys(e, WRITES, writeIdx, (next) =>
                    onWrites(next.id === "write"),
                  )
                }
              >
                {w.name}
              </button>
            ))}
          </div>
        )}
      </span>
    </div>
  );
}

/** Connecting a service just for this agent, kept at its own tier. */
function OwnConnection({
  api,
  agent,
  connector: c,
  onDone,
  onCancel,
}: {
  api: ConnectionsApi;
  agent: Agent;
  connector: Connector;
  onDone: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const title = `${c.name} for ${agent.name} only`;
  return (
    <div className="conn-card" role="group" aria-label={title}>
      <b>{title}</b>
      <Connect
        api={api}
        connector={c}
        at={{ level: "agent", agent: agent.id }}
        label={`Connect ${c.name}`}
        title={title}
        onDone={onDone}
        onCancel={onCancel}
        open
      />
    </div>
  );
}
