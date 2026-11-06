import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { ago } from "../crew/files";
import { HubError } from "../hub/client";
import {
  agentOnly,
  connectionsOf,
  mine,
  names,
  statusLine,
  type At,
  type Connection,
  type ConnectionsApi,
  type Connector,
  type Started,
} from "../hub/connections";
import { openUrl } from "../platform";
import "../styles/connections.css";
import { useLive } from "../ui/useLive";

const SAVED_WHERE = "Saved in Desk’s vault on this computer. Never in a file.";
const CANCELLED = "Sign-in was cancelled. Nothing was saved.";
const EXPIRED = "The sign-in timed out. Nothing was saved.";
/** How often a sign-in in progress is asked about. */
const FLOW_POLL_MS = 1500;

const ALL: At = { level: "all" };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The local hub's Connections, asked as the person. */
const localApi = (): ConnectionsApi | null => {
  const hub = useChat.getState().hubs.find((h) => h.local);
  return hub ? connectionsOf(hub) : null;
};

const dated = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";

/** Settings → Connections: the services agents on this computer can be
 *  given, connected once for all the person's agents or just for one. */
export function Connections({ api: given }: { api?: ConnectionsApi } = {}) {
  const [api] = useState<ConnectionsApi | null>(() => given ?? localApi());
  const [list, setList] = useState<Connector[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    setProblem(null);
    try {
      setList((await api.list()).connectors);
    } catch (e) {
      if (e instanceof HubError && e.status === 404) setUnsupported(true);
      else setProblem("Couldn’t ask the hub about connections just now.");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const nothing = list !== null && list.every((c) => c.connections.length === 0);

  return (
    <section className="settings-pane providers-pane connections-pane" aria-label="Connections">
      <header>
        <h1 className="display-lg">Connections</h1>
        <p className="muted">
          The services your agents on this computer can work in. Connect each one once for all your agents, then turn it on for the agents that
          need it in their Connectors.
        </p>
      </header>

      {!api || unsupported ? (
        <div className="setting-card">
          <span className="card-text">
            <span className="muted">This computer’s hub doesn’t offer connections yet. Update Desk to connect services.</span>
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

      {nothing && (
        <div className="setting-card connections-empty">
          <span className="card-text">
            <b>Nothing connected yet</b>
            <span>Connect the tools your agents work with. Each agent only gets the ones you turn on for it.</span>
          </span>
        </div>
      )}

      {api && list && list.length > 0 && (
        <div className="prov-list" role="list" aria-label="Connectors">
          {list.map((c) => (
            <ConnectorRow key={c.id} api={api} connector={c} reload={load} onNotice={setNotice} />
          ))}
        </div>
      )}

      {api && list === null && !problem && !unsupported && <p className="small faint">Looking…</p>}
    </section>
  );
}

/** One connector's row, and its detail when open. */
function ConnectorRow({
  api,
  connector: c,
  reload,
  onNotice,
}: {
  api: ConnectionsApi;
  connector: Connector;
  reload: () => Promise<void>;
  onNotice: (n: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const all = mine(c);
  const only = agentOnly(c);
  const trouble = c.connections.some((x) => x.status !== "connected");

  const status = (() => {
    if (all) return <span className={all.status === "connected" ? "state-on" : "state-blocked"}>{statusLine(all)}</span>;
    if (only.length > 0) {
      return <span>{only.length === 1 ? `Connected just for ${only[0]!.agentName ?? only[0]!.agent}` : `Connected for ${only.length} agents`}</span>;
    }
    return <span className="faint">Not connected</span>;
  })();

  const using = c.usedBy.length;
  return (
    <div className={`prov-row ${open ? "prov-row-open" : ""}`} role="listitem" aria-label={c.name}>
      <div className="conn-head">
        <span className={`conn-dot ${trouble ? "conn-dot-blocked" : all || only.length ? "conn-dot-on" : ""}`} aria-hidden="true" />
        <span className="prov-text">
          <b>{c.name}</b>
          <span>
            {status}
            {using > 0 && ` · ${using === 1 ? "1 agent uses it" : `${using} agents use it`}`}
          </span>
        </span>
        <button type="button" className="btn btn-ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : all || only.length ? "Manage" : "Connect"}
        </button>
      </div>
      {open && <ConnectorDetail api={api} connector={c} reload={reload} onNotice={onNotice} />}
    </div>
  );
}

function ConnectorDetail({
  api,
  connector: c,
  reload,
  onNotice,
}: {
  api: ConnectionsApi;
  connector: Connector;
  reload: () => Promise<void>;
  onNotice: (n: string | null) => void;
}) {
  const all = mine(c);
  const only = agentOnly(c);
  return (
    <div className="conn-detail">
      {all ? (
        <ConnectedCard api={api} connector={c} connection={all} at={ALL} reload={reload} onNotice={onNotice} />
      ) : (
        <>
          <p className="small muted">{c.about}</p>
          <Connect api={api} connector={c} at={ALL} label="Connect for all my agents" onDone={reload} />
        </>
      )}

      {c.usedBy.length > 0 && (
        <section className="conn-sub" aria-label="Used by">
          <h3 className="field-label">Used by</h3>
          <ul className="conn-used">
            {c.usedBy.map((u) => (
              <li key={u.agent}>
                <span>{u.name}</span>
                <span className="conn-tag">{u.connection === "own" ? "own connection" : "my connection"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {only.length > 0 && (
        <section className="conn-sub" aria-label="Agent-only connections">
          <h3 className="field-label">Agent-only connections</h3>
          {only.map((x) => (
            <ConnectedCard
              key={x.agent}
              api={api}
              connector={c}
              connection={x}
              at={{ level: "agent", agent: x.agent ?? "" }}
              reload={reload}
              onNotice={onNotice}
              title={`${c.name} for ${x.agentName ?? x.agent} only`}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/** A kept connection: whose, since when, and Test, Reconnect, Disconnect. */
function ConnectedCard({
  api,
  connector: c,
  connection: x,
  at,
  reload,
  onNotice,
  title,
}: {
  api: ConnectionsApi;
  connector: Connector;
  connection: Connection;
  at: At;
  reload: () => Promise<void>;
  onNotice: (n: string | null) => void;
  title?: string;
}) {
  const [busy, setBusy] = useState<null | "test" | "disconnect">(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  // Who loses it: the agents using this connection.
  const losing = c.usedBy.filter((u) => (at.level === "all" ? u.connection === "mine" : u.agent === at.agent)).map((u) => u.name);

  const run = async (kind: "test" | "disconnect", work: () => Promise<unknown>) => {
    setBusy(kind);
    setProblem(null);
    try {
      await work();
      await reload();
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(null);
    }
  };

  if (reconnecting) {
    return (
      <div className="conn-card">
        {title && <b>{title}</b>}
        <Connect
          api={api}
          connector={c}
          at={at}
          label={`Reconnect ${c.name}`}
          onDone={async () => {
            setReconnecting(false);
            await reload();
          }}
          onCancel={() => setReconnecting(false)}
          open
        />
      </div>
    );
  }

  return (
    <div className="conn-card">
      {title && <b>{title}</b>}
      <dl className="conn-facts">
        <div>
          <dt>Account</dt>
          <dd className={x.status === "connected" ? undefined : "state-blocked"}>{x.status === "connected" ? (x.account ?? "Connected") : statusLine(x)}</dd>
        </div>
        {x.connectedAt && (
          <div>
            <dt>Connected</dt>
            <dd>{dated(x.connectedAt)}</dd>
          </div>
        )}
        <div>
          <dt>Last checked</dt>
          <dd>{x.checkedAt ? ago(x.checkedAt) : "Not checked yet"}</dd>
        </div>
      </dl>
      {x.status !== "connected" && x.detail && (
        <p className="small state-blocked" role="status">
          {x.detail}
        </p>
      )}
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
      {confirming ? (
        <div className="prov-actions">
          <span className="small">
            {losing.length > 0
              ? `${names(losing)} will lose ${c.name}.`
              : `Disconnect ${c.name}${at.level === "agent" ? ` for ${x.agentName ?? at.agent}` : ""}?`}
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
            Keep
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy !== null}
            onClick={() =>
              void run("disconnect", async () => {
                const left = await api.disconnect(c.id, at);
                onNotice(left.note);
              }).then(() => setConfirming(false))
            }
          >
            {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      ) : (
        <div className="prov-actions">
          <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void run("test", () => api.test(c.id, at))}>
            {busy === "test" ? "Testing…" : "Test"}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => setReconnecting(true)}>
            Reconnect
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => setConfirming(true)}>
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
  label,
  onDone,
  onCancel,
  open: startOpen = false,
  title,
}: {
  api: ConnectionsApi;
  connector: Connector;
  at: At;
  label: string;
  onDone: () => void | Promise<void>;
  onCancel?: () => void;
  /** Show the form at once, rather than behind the button. */
  open?: boolean;
  title?: string;
}) {
  const [form, setForm] = useState(startOpen && c.signIn === "fields");
  const [problem, setProblem] = useState<string | null>(null);

  if (c.signIn === "google") {
    return <GoogleSignIn api={api} connector={c} at={at} onDone={onDone} onCancel={onCancel} />;
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
          <DeviceSignIn api={api} connector={c} at={at} onDone={onDone} onProblem={setProblem} onToken={() => setForm(true)} onCancel={onCancel} />
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
      title={title}
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
  title,
  onDone,
  onCancel,
}: {
  api: ConnectionsApi;
  connector: Connector;
  at: At;
  title?: string;
  onDone: () => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = c.fields.filter((f) => f.required).every((f) => values[f.name]?.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const fields = Object.fromEntries(
        Object.entries(values)
          .map(([k, v]) => [k, v.trim()])
          .filter(([, v]) => v),
      );
      await api.connect(c.id, at, fields);
      await onDone();
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
        <button type="submit" className="btn btn-signal" disabled={busy || !ready}>
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
  onDone,
  onProblem,
  onToken,
  onCancel,
}: {
  api: ConnectionsApi;
  connector: Connector;
  at: At;
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
      const s = await api.start(c.id, at);
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
        <button type="button" className="btn btn-signal" disabled={busy} onClick={() => void begin()}>
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
  onDone,
  onCancel,
}: {
  api: ConnectionsApi;
  connector: Connector;
  at: At;
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
      const s = await api.start(c.id, at);
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
        <button type="button" className="btn btn-signal" disabled={busy} onClick={() => void begin()}>
          {busy ? "Starting…" : "Sign in with Google"}
        </button>
      </div>
    </div>
  );
}
