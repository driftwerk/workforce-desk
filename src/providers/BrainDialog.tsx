import { useState } from "react";
import { brainSummary, isDefaultModel, resolveBrain, type Brain } from "../crew/brain";
import { defaultEffort, effortLine, effortName, GROUPS, type Provider } from "../hub/providers";
import { useDesk } from "../hub/store";
import { CloseButton, Dialog, radioKeys } from "../ui/Dialog";
import { ConnectForm } from "./ConnectForm";
import { useProviderList } from "./store";

/** Choosing how an agent thinks: a provider (connecting it if need be),
 *  one of its models and an effort. Only picks; `onUse` decides where the
 *  choice goes. */
export function BrainDialog({
  title,
  who,
  initial,
  onUse,
  onClose,
}: {
  /** "How Ledger thinks" */
  title: string;
  /** Who the footer says will use it: "Ledger", "New agents". */
  who: string;
  initial: Brain;
  onUse: (brain: Brain) => Promise<void> | void;
  onClose: () => void;
}) {
  const hub = useDesk((s) => s.hub);
  const { providers, loaded, problem, load } = useProviderList();
  const [selected, setSelected] = useState(initial.provider);
  // Each provider's model and effort, kept while you look at others.
  const [picks, setPicks] = useState<Record<string, Brain>>({ [initial.provider]: initial });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const provider = providers.find((p) => p.id === selected);
  const brain: Brain | null = provider ? (picks[provider.id] ?? resolveBrain({ provider: provider.id }, provider)) : null;
  const ready = !!provider?.connected && !!brain && provider.models.length > 0;
  const pick = (patch: Partial<Brain>) => brain && setPicks((all) => ({ ...all, [brain.provider]: { ...brain, ...patch } }));

  const use = async () => {
    if (!brain || !ready) return;
    setSaving(true);
    setFailure(null);
    try {
      await onUse(brain);
      onClose();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const summary = failure
    ? failure
    : !provider
      ? loaded
        ? "Choose a provider."
        : ""
      : !provider.connected
        ? `Connect ${provider.name} to choose one of its models.`
        : brain && provider.models.length > 0
          ? brainSummary(who, brain, provider)
          : `${provider.name} has no models to choose yet.`;

  return (
    <Dialog
      wide
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head dialog-head-rule">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              {title}
            </h1>
            <p>Pick a provider, then a model and how hard it should think.</p>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-body">
        <nav className="brain-nav" aria-label="Providers">
          {GROUPS.map((g) => {
            const items = providers.filter((p) => p.group === g.id);
            if (items.length === 0) return null;
            return (
              <div key={g.id} className="brain-group" role="group" aria-label={g.label}>
                <span className="field-label" aria-hidden="true">
                  {g.label}
                </span>
                {items.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="provider-row"
                    aria-current={p.id === selected ? "true" : undefined}
                    data-autofocus={p.id === selected ? true : undefined}
                    onClick={() => setSelected(p.id)}
                  >
                    <span className="provider-text">
                      <b>{p.name}</b>
                      <span>{p.description}</span>
                    </span>
                    <span className={`provider-status ${p.connected ? "on" : ""}`}>{p.connected ? "Connected" : "Connect"}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="brain-pane">
          {!loaded ? (
            <p className="muted">Looking at what you have connected…</p>
          ) : problem ? (
            <div className="connect-form">
              <p className="pane-empty">{problem}</p>
              <div className="connect-actions">
                <button type="button" className="btn" onClick={() => hub && void load(hub)}>
                  Try again
                </button>
              </div>
            </div>
          ) : !provider ? (
            <p className="pane-empty">Choose a provider on the left.</p>
          ) : !provider.connected ? (
            <div className="connect-form">
              <div className="dialog-title">
                <h2 className="display-md">Connect {provider.name}</h2>
                {provider.connect.kind !== "login" && provider.connect.hint && <p>{provider.connect.hint}</p>}
              </div>
              <ConnectForm
                key={provider.id}
                provider={provider}
                submitLabel="Connect"
                note={
                  provider.connect.kind === "probe"
                    ? "Its models appear here once Desk finds it."
                    : "Saved in this Mac’s vault. Its models appear here once it connects."
                }
              />
            </div>
          ) : provider.models.length === 0 ? (
            <p className="pane-empty">
              {provider.name} is connected but has no models yet.
              {provider.group === "local" ? " Add one to it, then come back." : ""}
            </p>
          ) : (
            brain && <Choices provider={provider} brain={brain} pick={pick} />
          )}
        </div>
      </div>
      <footer className="dialog-foot">
        <span className={`dialog-foot-note ${failure ? "state-blocked" : ""}`} aria-live="polite">
          {summary}
        </span>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-signal" disabled={!ready || saving} onClick={() => void use()}>
          {saving ? "Saving…" : "Use this"}
        </button>
      </footer>
    </Dialog>
  );
}

function Choices({ provider, brain, pick }: { provider: Provider; brain: Brain; pick: (patch: Partial<Brain>) => void }) {
  const modelIndex = provider.models.findIndex((m) => m.id === brain.model);
  const effort = brain.effort ?? defaultEffort(provider);
  const effortIndex = effort ? provider.efforts.indexOf(effort) : -1;
  return (
    <>
      <div className="field-stack">
        <span className="field-label" id="brain-model">
          Model
        </span>
        <div className="pick-list" role="radiogroup" aria-labelledby="brain-model">
          {provider.models.map((m, i) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              className="pick"
              aria-checked={m.id === brain.model}
              tabIndex={i === Math.max(modelIndex, 0) ? 0 : -1}
              onClick={() => pick({ model: m.id })}
              onKeyDown={(e) => radioKeys(e, provider.models, modelIndex, (next) => pick({ model: next.id }))}
            >
              <span className="radio-ring" aria-hidden="true" />
              <span className="pick-text">
                <b>{m.name}</b>
                <span>{m.description}</span>
              </span>
              {isDefaultModel(provider, m.id) && <span className="chip chip-default">Default</span>}
            </button>
          ))}
        </div>
      </div>
      {provider.efforts.length > 0 && effort && (
        <div className="field-stack">
          <span className="field-label" id="brain-effort">
            Effort
          </span>
          <div className="effort-seg" role="radiogroup" aria-labelledby="brain-effort">
            {provider.efforts.map((e, i) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={e === effort}
                tabIndex={i === Math.max(effortIndex, 0) ? 0 : -1}
                onClick={() => pick({ effort: e })}
                onKeyDown={(ev) => radioKeys(ev, provider.efforts, effortIndex, (next) => pick({ effort: next }))}
              >
                {effortName(e)}
              </button>
            ))}
          </div>
          <span className="muted">{effortLine(provider, effort)}</span>
        </div>
      )}
    </>
  );
}
