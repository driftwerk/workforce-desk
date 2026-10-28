import { effortShort, isDefaultEffort, isDefaultModel, modelName, type Brain } from "./brain";
import type { Provider } from "../hub/providers";
import { effortName } from "../hub/providers";

/** "How they think": the model on its provider, the effort, and Change. */
export function BrainCard({ brain, provider, onChange }: { brain: Brain | null; provider: Provider | undefined; onChange: () => void }) {
  const isDefault =
    !!brain && isDefaultModel(provider, brain.model) && (provider?.efforts.length === 0 || isDefaultEffort(provider, brain.effort));
  return (
    <div className="setting-card">
      <span className="card-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="9" cy="9" r="6.5" />
          <path d="M6 9h6M9 6v6" />
        </svg>
      </span>
      <span className="card-text">
        {brain ? (
          <>
            <b>
              {modelName(provider, brain.model)} <span>on your {provider?.name ?? "plan"}</span>
            </b>
            <span>
              {brain.effort ? `${effortName(brain.effort)} effort · ${effortShort(brain.effort)}` : (provider?.description ?? "")}
            </span>
          </>
        ) : (
          <b>…</b>
        )}
      </span>
      {isDefault && <span className="chip chip-default">Default</span>}
      <button type="button" className="btn" onClick={onChange} disabled={!brain}>
        Change
      </button>
    </div>
  );
}
