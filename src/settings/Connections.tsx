import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { ago } from "../crew/files";
import { HubError } from "../hub/client";
import {
  connectionsOf,
  forWhom,
  names,
  SET_UP_BY_AGENT,
  setUpRequest,
  statusLine,
  type At,
  type Connection,
  type ConnectionsApi,
  type Connector,
  type Started,
} from "../hub/connections";
import { useOverview } from "../overview/store";
import { openUrl } from "../platform";
import { useUi } from "../shell/ui";
import "../styles/connections.css";
import { askDeskTo } from "../ui/askDesk";
import { useLive } from "../ui/useLive";

const SAVED_WHERE = "Saved in Desk’s vault on this computer. Never in a file.";
const CANCELLED = "Sign-in was cancelled. Nothing was saved.";
const EXPIRED = "The sign-in timed out. Nothing was saved.";
/** How often a sign-in in progress is asked about. */
const FLOW_POLL_MS = 1500;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `text` ending as a sentence does. */
const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** What a name the person gives a connection of `c` clashes with: another
 *  of its connections by that name (`but` aside), or none. */
export const nameTaken = (c: Connector, name: string, but?: string): string | null => {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const same = c.connections.find((x) => x.id !== but && x.name.trim().toLowerCase() === n);
  return same ? `${c.name} has a connection called ${same.name} already. Give this one another name.` : null;
};

/** After a sign-in made `x` again as a new connection: each agent that
 *  picked `x` by name picks the new one in its place (taking changes as
 *  before, its default still), then `x` goes. What went wrong, in the
 *  person's words, or null. */
export const carryOver = async (api: ConnectionsApi, c: Connector, x: Connection): Promise<string | null> => {
  const before = new Set(c.connections.map((k) => k.id));
  let fresh: Connection | undefined;
  try {
    const now = (await api.list()).connectors.find((k) => k.id === c.id);
    fresh = now?.connections.find((k) => !before.has(k.id) && k.level === x.level && k.agent === x.agent);
  } catch {
    // Said below.
  }
  if (!fresh) return `Desk couldn’t find the new sign-in, so ${x.name} is kept as it was. Reconnect it again in a moment.`;
  const stuck: string[] = [];
  for (const u of x.usedBy) {
    try {
      const s = (await api.picks(u.agent)).find((v) => v.id === c.id);
      // One that follows whom a connection is for reaches the new one already.
      if (!s?.chosen) continue;
      const picked = s.connections.filter((p) => p.picked);
      if (!picked.some((p) => p.id === x.id)) continue;
      const swap = (id: string) => (id === x.id ? fresh.id : id);
      const def = picked.find((p) => p.default)?.id ?? null;
      await api.setPicks(u.agent, {
        service: c.id,
        connections: picked.map((p) => ({ id: swap(p.id), write: p.write })),
        default: def && swap(def),
      });
    } catch {
      stuck.push(u.name);
    }
  }
  if (stuck.length > 0)
    return `Signed in again, but Desk couldn’t move ${names(stuck)} over to it, so the old ${x.name} is kept for now. Reconnect it again to finish.`;
  try {
    await api.disconnect(c.id, x.id);
  } catch (e) {
    return `Signed in again, but Desk couldn’t remove the old ${x.name}: ${sentence(message(e))} Disconnect the old one here.`;
  }
  return null;
};

/** The local hub's Connections, asked as the person. */
const localApi = (): ConnectionsApi | null => {
  const hub = useChat.getState().hubs.find((h) => h.local);
  return hub ? connectionsOf(hub) : null;
};

/** The agents on this computer, for "Just one agent". */
const useLocalAgents = (): { id: string; name: string }[] => {
  const hub = useChat((s) => s.hubs.find((h) => h.local));
  const roster = useChat((s) => s.roster);
  return hub ? roster.filter((a) => a.hubId === hub.id).map((a) => ({ id: a.id, name: a.name })) : [];
};

/** Asks Desk's agent to set `c` up (or one the person names), in its
 *  chat. */
const askDesk = (c: Connector | null): boolean => {
  const asked = askDeskTo(
    c ? setUpRequest(c.name, "all") : "I’d like to connect a service for my agents. Ask me which one, then set it up in your browser.",
  );
  if (asked) useUi.getState().closeSettings();
  return asked;
};

/** Settings → Connections: the services agents on this computer work in.
 *  A service holds several connections, each named, kept for all the
 *  person's agents or just one; each agent uses the ones picked for it. */
export function Connections({
  api: given,
  ask = askDesk,
}: {
  api?: ConnectionsApi;
  /** Hands setting a service up to Desk's agent; false when there's none. */
  ask?: (c: Connector | null) => boolean;
} = {}) {
  const [api] = useState<ConnectionsApi | null>(() => given ?? localApi());
  const [list, setList] = useState<Connector[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canAsk = useOverview((s) => !!s.manager?.agentId) || given !== undefined;

  const load = useCallback(async () => {
    if (!api) return;
    setProblem(null);
    try {
      setList((await api.list()).connectors);
    } catch (e) {
      if (e instanceof HubError && e.status === 404) setUnsupported(true);
      else setProblem("Desk couldn’t read your connections just now.");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const askFor = (c: Connector | null) => {
    if (!ask(c)) setNotice("Desk’s agent isn’t on this computer to ask. Connect it yourself below.");
  };

  return (
    <section className="settings-pane providers-pane connections-pane" aria-label="Connections">
      <header className="conn-header">
        <div>
          <h1 className="display-lg">Connections</h1>
          <p className="muted">
            The services your agents on this computer work in. A service can have several connections — two Jira sites, work and personal
            email — each with its own name. Each agent uses only the ones you pick for it.
          </p>
        </div>
        {canAsk && (
          <button type="button" className="btn" onClick={() => askFor(null)}>
            Ask an agent to set one up
          </button>
        )}
      </header>

      {!api || unsupported ? (
        <div className="setting-card">
          <span className="card-text">
            <span className="muted">This version of Desk doesn’t offer connections yet. Update Desk to connect services.</span>
          </span>
        </div>
      ) : null}

      {problem && (
        <div className="setting-card">
          <span className="card-text">
            <span className="state-blocked" role="alert">
              {problem}
            </span>
          </span>
          <button type="button" className="btn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}

      {notice && (
        <div className="setting-card">
          <span className="card-text">
            <span className="state-blocked" role="status">
              {notice}
            </span>
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => setNotice(null)}>
            OK
          </button>
        </div>
      )}

      {api && list && list.length > 0 && (
        <div className="conn-services" role="list" aria-label="Services">
          {list.map((c, i) => (
            <ServiceCard
              key={c.id}
              api={api}
              connector={c}
              open={i === list.findIndex((x) => x.connections.length >= 2)}
              reload={load}
              onNotice={setNotice}
              onAsk={canAsk ? () => askFor(c) : undefined}
            />
          ))}
        </div>
      )}

      {api && list === null && !problem && !unsupported && <p className="small faint">Looking…</p>}
    </section>
  );
}

/** One service: its connections, open, or what they are, closed. */
function ServiceCard({
  api,
  connector: c,
  open: startOpen,
  reload,
  onNotice,
  onAsk,
}: {
  api: ConnectionsApi;
  connector: Connector;
  /** Open at first: the first service of several connections. */
  open: boolean;
  reload: () => Promise<void>;
  onNotice: (n: string | null) => void;
  onAsk?: () => void;
}) {
  const count = c.connections.length;
  const [open, setOpen] = useState(startOpen);
  const [adding, setAdding] = useState(false);
  const trouble = c.connections.filter((x) => x.status !== "connected");
  const using = c.usedBy.length;
  const agents = using === 1 ? "1 agent uses it" : `${using} agents use ${count >= 2 ? "them" : "it"}`;

  const summary = (() => {
    if (count === 0) return <span className="faint">Not connected</span>;
    if (open) return <span>{`${count === 1 ? "1 connection" : `${count} connections`}${using ? ` · ${agents}` : ""}`}</span>;
    return (
      <span>
        {c.connections.map((x, i) => (
          <span key={x.id}>
            {i > 0 && " · "}
            {x.name}
            {x.status !== "connected" && (
              <span className="state-blocked"> ({x.status === "failing" ? "not answering" : "needs signing in again"})</span>
            )}
          </span>
        ))}
        {using > 0 && ` · ${agents}`}
      </span>
    );
  })();

  return (
    <section className={`conn-service ${open ? "conn-service-open" : ""}`} role="listitem" aria-label={c.name}>
      <div className="conn-head">
        <span className={`conn-dot ${trouble.length ? "conn-dot-blocked" : count ? "conn-dot-on" : ""}`} aria-hidden="true" />
        <b className="conn-service-name">{c.name}</b>
        <span className="conn-summary small">{summary}</span>
        <span className="conn-head-actions">
          {count === 0 ? (
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setOpen(true);
                  setAdding(true);
                }}
              >
                Connect
              </button>
              {onAsk && SET_UP_BY_AGENT.has(c.id) && (
                <button type="button" className="btn btn-sm btn-signal" onClick={onAsk}>
                  Have Desk set it up
                </button>
              )}
            </>
          ) : open ? (
            <>
              {c.several && !adding && (
                <button type="button" className="btn btn-sm btn-signal-outline" onClick={() => setAdding(true)}>
                  + Add another {c.name}
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-expanded
                onClick={() => {
                  setOpen(false);
                  setAdding(false);
                }}
              >
                Close
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-sm" aria-expanded={false} onClick={() => setOpen(true)}>
              Manage
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="conn-body">
          {count === 0 && <p className="small muted">{c.about}</p>}
          {count > 0 && (
            <div className="conn-grid">
              {c.connections.map((x) => (
                <ConnectionCard key={x.id} api={api} connector={c} connection={x} reload={reload} onNotice={onNotice} />
              ))}
            </div>
          )}
          {adding && (
            <AddConnection
              api={api}
              connector={c}
              first={count === 0}
              onDone={async () => {
                setAdding(false);
                await reload();
              }}
              onCancel={() => {
                setAdding(false);
                if (count === 0) setOpen(false);
              }}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** A new connection: its name, whom it is for, then its sign-in or keys. */
function AddConnection({
  api,
  connector: c,
  first,
  onDone,
  onCancel,
}: {
  api: ConnectionsApi;
  connector: Connector;
  first: boolean;
  onDone: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const agents = useLocalAgents();
  const [name, setName] = useState("");
  const [whom, setWhom] = useState<string>("all");
  const at: At = whom === "all" ? { level: "all" } : { level: "agent", agent: whom };
  const title = first ? `Connect ${c.name}` : `Add another ${c.name}`;
  const clash = c.several ? nameTaken(c, name) : null;
  return (
    <div className="conn-card conn-add" role="group" aria-label={title}>
      <b>{title}</b>
      <div className="conn-add-row">
        {c.several && (
          <label className="field-stack">
            <span className="field-label">Name</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              data-autofocus
              maxLength={80}
              placeholder={c.nameHint || c.name}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        <label className="field-stack">
          <span className="field-label">For</span>
          <select className="ability-select" value={whom} onChange={(e) => setWhom(e.target.value)}>
            <option value="all">All my agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                Just {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {clash && (
        <p className="small state-blocked" role="alert">
          {clash}
        </p>
      )}
      <Connect
        api={api}
        connector={c}
        at={at}
        name={name}
        label={`Connect ${c.name}`}
        blocked={!!clash}
        onDone={() => onDone()}
        onCancel={onCancel}
        open
      />
    </div>
  );
}

/** One connection: its name and site, whose account, for whom and who uses
 *  it, and Test, Rename, Reconnect, Disconnect. */
function ConnectionCard({
  api,
  connector: c,
  connection: x,
  reload,
  onNotice,
}: {
  api: ConnectionsApi;
  connector: Connector;
  connection: Connection;
  reload: () => Promise<void>;
  onNotice: (n: string | null) => void;
}) {
  const [busy, setBusy] = useState<null | "test" | "disconnect" | "rename">(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const losing = x.usedBy.map((u) => u.name);

  const run = async (kind: "test" | "disconnect" | "rename", work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(kind);
    setProblem(null);
    try {
      await work();
      await reload();
      return true;
    } catch (e) {
      setProblem(message(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const at: At = x.level === "all" ? { level: "all" } : { level: "agent", agent: x.agent ?? "" };
  const clash = renaming !== null ? nameTaken(c, renaming, x.id) : null;

  if (reconnecting) {
    return (
      <div className="conn-card">
        <b>Reconnect {x.name}</b>
        <Connect
          api={api}
          connector={c}
          at={at}
          name={x.name}
          reconnect={c.fields.length > 0 ? x.id : undefined}
          label={`Reconnect ${x.name}`}
          onDone={async (inPlace) => {
            // New keys keep the connection as it is; a sign-in makes a new
            // one, which takes the old one's place for its agents.
            const wrong = inPlace ? null : await carryOver(api, c, x);
            setProblem(wrong);
            setReconnecting(false);
            await reload();
          }}
          onCancel={() => setReconnecting(false)}
          open
        />
      </div>
    );
  }

  const ok = x.status === "connected";
  return (
    <div className={`conn-card ${ok ? "" : "conn-card-trouble"}`} aria-label={x.name}>
      <div className="conn-card-head">
        {renaming !== null ? (
          <form
            className="conn-rename"
            onSubmit={(e) => {
              e.preventDefault();
              if (!renaming.trim() || clash) return;
              void run("rename", () => api.rename(c.id, x.id, renaming.trim())).then((done) => done && setRenaming(null));
            }}
          >
            <input
              type="text"
              aria-label={`New name for ${x.name}`}
              data-autofocus
              maxLength={80}
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
            />
            <button type="submit" className="btn btn-sm btn-signal" disabled={busy !== null || !renaming.trim() || !!clash}>
              {busy === "rename" ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <b>{x.name}</b>
            {x.site && <span className="mono conn-site">{x.site.replace(/^https?:\/\//, "")}</span>}
          </>
        )}
        <span className={`conn-status small ${ok ? "state-on" : "state-blocked"}`}>{statusLine(x)}</span>
      </div>
      {clash && (
        <p className="small state-blocked" role="alert">
          {clash}
        </p>
      )}
      <dl className="conn-facts">
        <div>
          <dt>Account</dt>
          <dd>{x.account ?? "—"}</dd>
        </div>
        <div>
          <dt>For</dt>
          <dd>{forWhom(x)}</dd>
        </div>
        <div>
          <dt>Used by</dt>
          <dd>{losing.length ? names(losing) : "No agent yet"}</dd>
        </div>
      </dl>
      {!ok && (
        <p className="small state-blocked conn-fix" role="status">
          {sentence(x.detail ?? (x.status === "failing" ? `${c.name} isn’t answering` : `${c.name} no longer takes this key`))}{" "}
          {x.status === "failing" ? "Test it again in a moment, or reconnect it." : "Reconnect it to carry on."}
        </p>
      )}
      {x.checkedAt && ok && <p className="small faint">Checked {ago(x.checkedAt)}</p>}
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
      {confirming ? (
        <div className="prov-actions">
          <span className="small">{losing.length > 0 ? `${names(losing)} will lose ${x.name}.` : `Disconnect ${x.name}?`}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming(false)}>
            Keep
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={busy !== null}
            onClick={() =>
              void run("disconnect", async () => {
                const left = await api.disconnect(c.id, x.id);
                onNotice(left.note);
              }).then(() => setConfirming(false))
            }
          >
            {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      ) : (
        <div className="prov-actions conn-actions">
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void run("test", () => api.test(c.id, x.id))}>
            {busy === "test" ? "Testing…" : "Test"}
          </button>
          {c.several && (
            <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setRenaming(x.name)}>
              Rename
            </button>
          )}
          <button type="button" className={`btn btn-sm ${ok ? "" : "btn-signal"}`} disabled={busy !== null} onClick={() => setReconnecting(true)}>
            Reconnect
          </button>
          <button type="button" className="btn btn-sm btn-ghost conn-disconnect" disabled={busy !== null} onClick={() => setConfirming(true)}>
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

/** Connecting `connector` at `at`: its sign-in, or its fields. */
export function Connect({
  api,
  connector: c,
  at,
  name,
  reconnect,
  label,
  onDone,
  onCancel,
  open: startOpen = false,
  title,
  blocked = false,
}: {
  api: ConnectionsApi;
  connector: Connector;
  at: At;
  /** The name the person gave the new connection. */
  name?: string;
  /** The connection whose keys these replace. */
  reconnect?: string;
  label: string;
  onDone: (inPlace?: boolean) => void | Promise<void>;
  onCancel?: () => void;
  /** Show the form at once, rather than behind the button. */
  open?: boolean;
  title?: string;
  /** It can't go ahead yet (its name is taken): said beside it. */
  blocked?: boolean;
}) {
  const [form, setForm] = useState(startOpen && c.signIn === "fields");
  const [problem, setProblem] = useState<string | null>(null);

  if (c.signIn === "google") {
    return <GoogleSignIn api={api} connector={c} at={at} name={name} blocked={blocked} onDone={() => onDone()} onCancel={onCancel} />;
  }
  if (c.signIn === "github" && !form) {
    return (
      <div className="connect-form">
        {problem && (
          <p className="small state-blocked" role="alert">
            {problem}
          </p>
        )}
        {c.signInReady ? (
          <DeviceSignIn
            api={api}
            connector={c}
            at={at}
            name={name}
            blocked={blocked}
            onDone={() => onDone()}
            onProblem={setProblem}
            onToken={() => setForm(true)}
            onCancel={onCancel}
          />
        ) : (
          <div className="connect-actions">
            {onCancel && (
              <button type="button" className="btn btn-ghost" onClick={onCancel}>
                Cancel
              </button>
            )}
            <button type="button" className="btn btn-signal" onClick={() => setForm(true)}>
              {label}
            </button>
          </div>
        )}
      </div>
    );
  }
  if (!form) {
    return (
      <div className="connect-actions">
        <button type="button" className="btn btn-signal" onClick={() => setForm(true)}>
          {label}
        </button>
      </div>
    );
  }
  return (
    <FieldsForm
      api={api}
      connector={c}
      at={at}
      name={name}
      reconnect={reconnect}
      title={title}
      blocked={blocked}
      onDone={onDone}
      onCancel={() => {
        setForm(false);
        onCancel?.();
      }}
    />
  );
}

/** The connector's fields, tested by the hub before anything is kept. */
export function FieldsForm({
  api,
  connector: c,
  at,
  name,
  reconnect,
  title,
  blocked = false,
  onDone,
  onCancel,
}: {
  api: ConnectionsApi;
  connector: Connector;
  at: At;
  name?: string;
  reconnect?: string;
  blocked?: boolean;
  title?: string;
  /** Told whether the keys went to the connection being reconnected. */
  onDone: (inPlace?: boolean) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = c.fields.filter((f) => f.required).every((f) => values[f.name]?.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy || blocked) return;
    setBusy(true);
    setProblem(null);
    try {
      const fields = Object.fromEntries(
        Object.entries(values)
          .map(([k, v]) => [k, v.trim()])
          .filter(([, v]) => v),
      );
      if (reconnect) await api.reconnect(c.id, reconnect, fields);
      else await api.connect(c.id, at, fields, name?.trim() || undefined);
      await onDone(!!reconnect);
    } catch (err) {
      setProblem(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="connect-form" onSubmit={submit} aria-label={title ?? `Connect ${c.name}`}>
      {title && <b>{title}</b>}
      {c.fields.map((f, i) => (
        <label key={f.name} className="field-stack">
          <span className="field-label">
            {f.label}
            {!f.required && <span className="faint"> (optional)</span>}
          </span>
          <input
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            data-autofocus={i === 0 ? true : undefined}
            placeholder={f.placeholder}
            value={values[f.name] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
          />
        </label>
      ))}
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
      <div className="connect-actions">
        <span className="small faint conn-where">{SAVED_WHERE}</span>
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-signal" disabled={busy || !ready || blocked}>
          {busy ? "Testing…" : "Save and connect"}
        </button>
      </div>
    </form>
  );
}

/** Waits on a sign-in the hub is finishing: asks where it is until it
 *  ends, then says so. */
const useFlow = (api: ConnectionsApi, onDone: () => void | Promise<void>) => {
  const [started, setStarted] = useState<Started | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const live = useLive();
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (!started) return;
    let stop = false;
    const tick = async () => {
      if (stop || !live.current) return;
      try {
        const at = await api.flow(started.flow);
        if (stop || !live.current) return;
        switch (at.state) {
          case "waiting":
            break;
          case "connected":
            setStarted(null);
            await done.current();
            return;
          case "cancelled":
            setStarted(null);
            setSaid(CANCELLED);
            return;
          case "expired":
            setStarted(null);
            setSaid(EXPIRED);
            return;
          case "failed":
            setStarted(null);
            setSaid(`${at.error}. Nothing was saved.`);
            return;
        }
      } catch {
        /* asked again below */
      }
      timer = setTimeout(() => void tick(), FLOW_POLL_MS);
    };
    let timer = setTimeout(() => void tick(), FLOW_POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [api, started]);

  const cancel = async () => {
    if (!started) return;
    const flow = started.flow;
    setStarted(null);
    setSaid(CANCELLED);
    await api.cancel(flow).catch(() => {});
  };

  return { started, setStarted, said, setSaid, cancel };
};

/** GitHub's device sign-in: a code to type at github.com, no secret here. */
function DeviceSignIn({
  api,
  connector: c,
  at,
  name,
  blocked = false,
  onDone,
  onProblem,
  onToken,
  onCancel,
}: {
  api: ConnectionsApi;
  connector: Connector;
  at: At;
  name?: string;
  blocked?: boolean;
  onDone: () => void | Promise<void>;
  onProblem: (p: string | null) => void;
  onToken: () => void;
  onCancel?: () => void;
}) {
  const { started, setStarted, said, setSaid, cancel } = useFlow(api, onDone);
  const [busy, setBusy] = useState(false);

  const begin = async () => {
    setBusy(true);
    setSaid(null);
    onProblem(null);
    try {
      const s = await api.start(c.id, at, name?.trim() || undefined);
      setStarted(s);
      if (s.verificationUri) openUrl(s.verificationUri);
    } catch (e) {
      onProblem(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (started) {
    return (
      <div className="conn-flow" role="status">
        <p className="small">
          Type this code at <span className="mono">{started.verificationUri?.replace(/^https?:\/\//, "")}</span>, then come back.
        </p>
        <p className="conn-code mono">{started.userCode}</p>
        <div className="connect-actions">
          <span className="small faint">Waiting for GitHub…</span>
          <button type="button" className="btn btn-ghost" onClick={() => void cancel()}>
            Cancel
          </button>
          {started.verificationUri && (
            <button type="button" className="btn" onClick={() => openUrl(started.verificationUri!)}>
              Open GitHub
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <>
      {said && (
        <p className="small state-blocked" role="status">
          {said}
        </p>
      )}
      <div className="connect-actions">
        <button type="button" className="link small" onClick={onToken}>
          Use a token instead
        </button>
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="btn btn-signal" disabled={busy || blocked} onClick={() => void begin()}>
          {busy ? "Starting…" : "Sign in with GitHub"}
        </button>
      </div>
    </>
  );
}

/** Google's sign-in on the person's own OAuth client: the client first,
 *  once, then the browser. */
function GoogleSignIn({
  api,
  connector: c,
  at,
  name,
  blocked = false,
  onDone,
  onCancel,
}: {
  api: ConnectionsApi;
  connector: Connector;
  at: At;
  name?: string;
  blocked?: boolean;
  onDone: () => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [ready, setReady] = useState(c.signInReady);
  const [client, setClient] = useState({ id: "", secret: "" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { started, setStarted, said, setSaid, cancel } = useFlow(api, onDone);

  const saveClient = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await api.saveGoogleClient(client.id.trim(), client.secret.trim());
      setReady(true);
    } catch (err) {
      setProblem(message(err));
    } finally {
      setBusy(false);
    }
  };

  const begin = async () => {
    setBusy(true);
    setSaid(null);
    setProblem(null);
    try {
      const s = await api.start(c.id, at, name?.trim() || undefined);
      setStarted(s);
      if (s.url) openUrl(s.url);
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (!ready) {
    return (
      <form className="connect-form" onSubmit={saveClient} aria-label="Your Google OAuth client">
        <p className="small muted">
          Google signs in on your own OAuth client. Create a Desktop app client in Google Cloud Console, then paste its ID and secret here.
        </p>
        <label className="field-stack">
          <span className="field-label">Client ID</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            data-autofocus
            value={client.id}
            onChange={(e) => setClient((v) => ({ ...v, id: e.target.value }))}
          />
        </label>
        <label className="field-stack">
          <span className="field-label">Client secret</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={client.secret}
            onChange={(e) => setClient((v) => ({ ...v, secret: e.target.value }))}
          />
        </label>
        {problem && (
          <p className="small state-blocked" role="alert">
            {problem}
          </p>
        )}
        <div className="connect-actions">
          <span className="small faint conn-where">{SAVED_WHERE}</span>
          {onCancel && (
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn btn-signal" disabled={busy || !client.id.trim() || !client.secret.trim()}>
            {busy ? "Saving…" : "Save client"}
          </button>
        </div>
      </form>
    );
  }

  if (started) {
    return (
      <div className="conn-flow" role="status">
        <p className="small">Finish signing in to Google in your browser, then come back.</p>
        <div className="connect-actions">
          <span className="small faint">Waiting for Google…</span>
          <button type="button" className="btn btn-ghost" onClick={() => void cancel()}>
            Cancel
          </button>
          {started.url && (
            <button type="button" className="btn" onClick={() => openUrl(started.url!)}>
              Open Google
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="connect-form">
      {(problem ?? said) && (
        <p className="small state-blocked" role={problem ? "alert" : "status"}>
          {problem ?? said}
        </p>
      )}
      <div className="connect-actions">
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="btn btn-signal" disabled={busy || blocked} onClick={() => void begin()}>
          {busy ? "Starting…" : "Sign in with Google"}
        </button>
      </div>
    </div>
  );
}
