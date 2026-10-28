import { useState } from "react";
import { useChat } from "../chat/store";
import { brainOn, newAgentBrain } from "../crew/brain";
import { PLAN_OF, type Provider, type ProviderGroup } from "../hub/providers";
import { useDesk } from "../hub/store";
import { BrainDialog } from "../providers/BrainDialog";
import { ConnectForm } from "../providers/ConnectForm";
import { useProviderList, useProviders } from "../providers/store";
import { PlanLoginAction, ReopenLink, usePlanLogin } from "./PlanLogin";
import { useSettings } from "./store";

const SECTIONS: { group: ProviderGroup; label: string }[] = [
  { group: "plan", label: "Your plans" },
  { group: "key", label: "API keys" },
  { group: "local", label: "On this Mac or your network" },
];

/** "Desk, Ledger and Scout" */
const names = (list: string[]): string =>
  list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;

/** What agents on this Mac can think with: plans, API keys and models
 *  running here, and where new agents start. */
export function Providers() {
  const { providers, loaded, problem, load } = useProviderList();
  const hub = useDesk((s) => s.hub);
  const saved = useSettings((s) => s.newAgent);
  const set = useSettings((s) => s.set);
  const roster = useChat((s) => s.roster);
  const [choosing, setChoosing] = useState(false);

  const start = newAgentBrain(saved, providers);
  const startOn = providers.find((p) => p.id === start.provider);
  const usedBy = (id: string) => roster.filter((a) => a.hubId === "local" && a.provider === id).map((a) => a.name);

  return (
    <section className="settings-pane providers-pane" aria-label="Providers">
      <header>
        <h1 className="display-lg">Providers</h1>
        <p className="muted">
          Connect what your agents on this Mac can think with. Each agent picks its own provider, model and effort in its settings.
        </p>
      </header>

      <div className="setting-card">
        <span className="card-text">
          <b>New agents start on</b>
          <span>{loaded ? brainOn(start, startOn) : "…"}</span>
        </span>
        <button type="button" className="btn" disabled={!loaded} onClick={() => setChoosing(true)}>
          Change
        </button>
      </div>

      {problem && (
        <div className="setting-card">
          <span className="card-text">
            <span className="state-blocked">{problem}</span>
          </span>
          <button type="button" className="btn" onClick={() => hub && void load(hub)}>
            Try again
          </button>
        </div>
      )}

      {SECTIONS.map(({ group, label }) => {
        const items = providers.filter((p) => p.group === group);
        if (items.length === 0) return null;
        return (
          <section key={group} className="prov-section" aria-label={label}>
            <h2 className="field-label">{label}</h2>
            <div className="prov-list">
              {items.map((p) => (
                <ProviderRow key={p.id} provider={p} usedBy={usedBy(p.id)} />
              ))}
            </div>
          </section>
        );
      })}

      <p className="small faint">Keys are kept in this Mac’s vault and never leave it except to call the provider. Speech keys live under Voices.</p>

      {choosing && (
        <BrainDialog
          title="How new agents think"
          who="New agents"
          initial={start}
          onUse={(brain) => set({ newAgent: brain })}
          onClose={() => setChoosing(false)}
        />
      )}
    </section>
  );
}

function ProviderRow({ provider, usedBy }: { provider: Provider; usedBy: string[] }) {
  const hub = useDesk((s) => s.hub);
  const { load, connect, disconnect, fallback } = useProviders();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const login = usePlanLogin(provider.connect.kind === "login" ? PLAN_OF[provider.id] : undefined, () => hub && void load(hub));

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (open && !provider.connected) {
    return (
      <div className="prov-row prov-row-open">
        <span className="prov-text">
          <b>{provider.name}</b>
          <span>{provider.connect.hint ?? provider.description}</span>
        </span>
        <ConnectForm provider={provider} submitLabel="Save and connect" onConnected={() => setOpen(false)} onCancel={() => setOpen(false)} />
      </div>
    );
  }

  const status = (() => {
    if (provider.connect.kind === "login" && login.status) return login.status;
    if (provider.connected) {
      return confirming ? `${names(usedBy)} ${usedBy.length === 1 ? "uses" : "use"} it. Disconnect anyway?` : null;
    }
    return provider.connect.kind === "probe" ? (provider.connect.hint ?? provider.description) : provider.description;
  })();

  const action = (() => {
    if (provider.connected) {
      // Plans connected before this Mac could list providers sign in again
      // rather than disconnect.
      if (fallback) return <PlanLoginAction login={login} label="Reconnect" signal={false} />;
      if (confirming) {
        return (
          <span className="prov-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
              Keep
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void run(() => (hub ? disconnect(hub, provider.id) : Promise.resolve())).then(() => setConfirming(false))}
            >
              Disconnect
            </button>
          </span>
        );
      }
      return (
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => (usedBy.length > 0 ? setConfirming(true) : void run(() => (hub ? disconnect(hub, provider.id) : Promise.resolve())))}
        >
          {busy ? "Disconnecting…" : "Disconnect"}
        </button>
      );
    }
    switch (provider.connect.kind) {
      case "login":
        return <PlanLoginAction login={login} label="Connect" signal={false} />;
      case "probe":
        return (
          <span className="prov-actions">
            {provider.connect.fields.length > 0 && (
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
                Another address
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void run(() => (hub ? connect(hub, provider.id, {}) : Promise.resolve()))}
            >
              {busy ? "Looking…" : "Check again"}
            </button>
          </span>
        );
      default: {
        const fields = provider.connect.fields;
        const label = provider.group === "local" ? "Set up" : fields.length === 1 && fields[0]!.secret ? "Add key" : "Connect";
        return (
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            {label}
          </button>
        );
      }
    }
  })();

  return (
    <div className="prov-row">
      <span className="prov-text">
        <b>{provider.name}</b>
        <span className={login.failed || problem ? "state-blocked" : undefined} role={problem ? "alert" : undefined}>
          {problem ??
            status ??
            (provider.connected && (
              <>
                <span className="state-on">Connected</span>
                {usedBy.length > 0 && ` · used by ${names(usedBy)}`}
              </>
            ))}
          {provider.connect.kind === "login" && <ReopenLink login={login} />}
        </span>
      </span>
      {action}
    </div>
  );
}
