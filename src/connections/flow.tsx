import { useEffect, useRef, useState } from "react";
import { useChat } from "../chat/store";
import {
  appWords,
  type ConnectionsApi,
  type Connector,
  type Started,
} from "../hub/connections";
import { useOverview } from "../overview/store";
import { openUrl } from "../platform";
import "../styles/connections.css";
import { useLive } from "../ui/useLive";

export const SAVED_WHERE =
  "Saved in Desk’s vault on this computer. Never in a file.";
const CANCELLED = "Sign-in was cancelled. Nothing was saved.";
const EXPIRED = "The sign-in timed out. Nothing was saved.";
/** How often a sign-in in progress is asked about. */
const FLOW_POLL_MS = 1500;

export const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** The agent on this computer that sets services up for the person: Desk's
 *  own, as the roster names it. */
export const useSetUpAgent = (): { id: string; name: string } | null => {
  const id = useOverview((s) => s.manager?.agentId);
  const hub = useChat((s) => s.hubs.find((h) => h.local));
  const name = useChat(
    (s) => s.roster.find((a) => a.id === id && a.hubId === hub?.id)?.name,
  );
  return id ? { id, name: name ?? "Desk" } : null;
};

/** Waits on a sign-in the hub is finishing: asks where it is until it
 *  ends, then says so. */
export const useFlow = (
  api: ConnectionsApi,
  onDone: (account?: string) => void | Promise<void>,
) => {
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
            await done.current(at.account);
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

/** A sign-in in the browser, being waited on. */
export function WaitingFor({
  service,
  started,
  onCancel,
}: {
  service: string;
  started: Started;
  onCancel: () => void;
}) {
  return (
    <div className="conn-flow" role="status">
      <p className="small">
        Finish signing in to {service} in your browser, then come back.
      </p>
      <div className="connect-actions">
        <span className="small faint">Waiting for {service}…</span>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        {started.url && (
          <button
            type="button"
            className="btn"
            onClick={() => openUrl(started.url!)}
          >
            Open {service}
          </button>
        )}
      </div>
    </div>
  );
}

/** The identifier and secret of the person's own app at a service, kept in
 *  the hub's vault before anything is signed in to. */
export function AppForm({
  api,
  connector: c,
  onKept,
  onCancel,
}: {
  api: ConnectionsApi;
  connector: Connector;
  onKept: () => void | Promise<void>;
  onCancel?: () => void;
}) {
  const words = appWords(c.id);
  const [app, setApp] = useState({ id: "", secret: "" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await api.saveApp(c.id, app.id.trim(), app.secret.trim());
      await onKept();
    } catch (err) {
      setProblem(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="connect-form"
      onSubmit={save}
      aria-label={`Your ${c.name} app`}
    >
      <label className="field-stack">
        <span className="field-label">{words.id}</span>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          data-autofocus
          value={app.id}
          onChange={(e) => setApp((v) => ({ ...v, id: e.target.value }))}
        />
      </label>
      <label className="field-stack">
        <span className="field-label">{words.secret}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={app.secret}
          onChange={(e) => setApp((v) => ({ ...v, secret: e.target.value }))}
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
        <button
          type="submit"
          className="btn btn-signal"
          disabled={busy || !app.id.trim() || !app.secret.trim()}
        >
          {busy ? "Saving…" : "Save app"}
        </button>
      </div>
    </form>
  );
}
