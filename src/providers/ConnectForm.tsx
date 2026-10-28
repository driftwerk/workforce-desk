import { useState } from "react";
import { PLAN_OF, type Provider } from "../hub/providers";
import { useDesk } from "../hub/store";
import { PlanLoginAction, ReopenLink, usePlanLogin } from "../settings/PlanLogin";
import { useProviders } from "./store";

/** What connecting `provider` takes: its own sign-in for a plan, else its
 *  fields (a key, an address) and a button. */
export function ConnectForm({
  provider,
  submitLabel,
  note,
  onConnected,
  onCancel,
}: {
  provider: Provider;
  submitLabel: string;
  note?: string;
  onConnected?: (p: Provider) => void;
  onCancel?: () => void;
}) {
  return provider.connect.kind === "login" ? (
    <PlanConnect provider={provider} onConnected={onConnected} onCancel={onCancel} />
  ) : (
    <FieldsConnect provider={provider} submitLabel={submitLabel} note={note} onConnected={onConnected} onCancel={onCancel} />
  );
}

function PlanConnect({ provider, onConnected, onCancel }: { provider: Provider; onConnected?: (p: Provider) => void; onCancel?: () => void }) {
  const hub = useDesk((s) => s.hub);
  const load = useProviders((s) => s.load);
  const login = usePlanLogin(PLAN_OF[provider.id], () => {
    if (!hub) return;
    void load(hub).then(() => {
      const now = useProviders.getState().providers.find((p) => p.id === provider.id);
      if (now) onConnected?.(now);
    });
  });
  return (
    <div className="connect-form">
      {(login.status ?? provider.connect.hint) && (
        <p className={`small ${login.failed ? "state-blocked" : "muted"}`} role="status">
          {login.status ?? provider.connect.hint}
          <ReopenLink login={login} />
        </p>
      )}
      <div className="connect-actions">
        {onCancel && !login.busy && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <PlanLoginAction login={login} label={`Sign in to ${provider.name.replace(/ plan$/, "")}`} />
      </div>
    </div>
  );
}

function FieldsConnect({
  provider,
  submitLabel,
  note,
  onConnected,
  onCancel,
}: {
  provider: Provider;
  submitLabel: string;
  note?: string;
  onConnected?: (p: Provider) => void;
  onCancel?: () => void;
}) {
  const hub = useDesk((s) => s.hub);
  const connect = useProviders((s) => s.connect);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const probe = provider.connect.kind === "probe";
  const required = provider.connect.fields.filter((f) => f.required ?? !/optional/i.test(f.label));
  const ready = probe || required.every((f) => values[f.name]?.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hub || !ready) return;
    setBusy(true);
    setProblem(null);
    try {
      const fields = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
      const next = await connect(hub, provider.id, fields);
      if (next.connected) onConnected?.(next);
      else setProblem(next.connect.hint ?? `Desk couldn’t find ${provider.name}.`);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="connect-form" onSubmit={submit} aria-label={`Connect ${provider.name}`}>
      {provider.connect.fields.map((f, i) => (
        <label key={f.name} className="field-stack">
          <span className="field-label">{f.label}</span>
          {f.multiline ? (
            <textarea
              className="connect-file"
              rows={6}
              autoComplete="off"
              spellCheck={false}
              data-autofocus={i === 0 ? true : undefined}
              placeholder={f.placeholder}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            />
          ) : (
            <input
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              data-autofocus={i === 0 ? true : undefined}
              placeholder={f.placeholder}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            />
          )}
        </label>
      ))}
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
      <div className="connect-actions">
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-signal" disabled={busy || !ready}>
          {busy ? (probe ? "Looking…" : "Connecting…") : submitLabel}
        </button>
        {note && <span className="small faint">{note}</span>}
      </div>
    </form>
  );
}
