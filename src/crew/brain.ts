import { parse, stringify } from "smol-toml";
import { defaultEffort, defaultModel, effortName, EFFORTS, effortsFor, type Provider } from "../hub/providers";

/** How an agent thinks: its provider, a model of that provider and, where
 *  the provider has one, an effort. */
export interface Brain {
  /** The provider's entry in the hub's list. */
  provider: string;
  model: string;
  effort?: string;
  /** What the config names to run `model`, when that isn't `provider`
   *  (Bedrock's `bedrock:anthropic`). */
  runsOn?: string;
  /** Ask the plan's faster tier (`[llm] fast`), where the model has one. */
  fast?: boolean;
}

/** Desk's saved default for new agents: unset parts mean that provider's
 *  default. */
export interface BrainChoice {
  provider: string;
  model?: string;
  effort?: string;
  fast?: boolean;
}

/** What older agents' configs name instead of a model. */
const TIERS = new Set(["standard", "powerful", "cheap"]);

const RICH = { tables: true, charts: true, forms: true, maps: true, diagrams: true, images: true };

type Doc = Record<string, unknown>;

const parseDoc = (source: string): Doc => (source.trim() ? (parse(source) as Doc) : {});

const byId = (providers: readonly Provider[], id: string): Provider | undefined => providers.find((p) => p.id === id);

const runsOn = (p: Provider, model: string): string => p.models.find((m) => m.id === model)?.provider ?? p.id;

/** The entry a config's `provider` belongs to: its id, or the entry with a
 *  model run on it (`bedrock:anthropic` is Bedrock's). */
const entryOf = (providers: readonly Provider[], configured: string, model: string | null): Provider | undefined =>
  byId(providers, configured) ??
  providers.find((p) => p.models.some((m) => m.provider === configured && m.id === model)) ??
  providers.find((p) => p.models.some((m) => m.provider === configured));

const withRunsOn = (brain: Brain, p: Provider): Brain => {
  const on = runsOn(p, brain.model);
  return on === p.id ? brain : { ...brain, runsOn: on };
};

/** `choice` made whole against its provider: a model the provider doesn't
 *  offer becomes its default, an effort the model doesn't offer the model's
 *  default; no effort where the model has none. Without
 *  the provider's list, the choice as given (a tier name for the model). */
export const resolveBrain = (choice: BrainChoice, provider: Provider | undefined): Brain => {
  if (!provider) return { provider: choice.provider, model: choice.model ?? "standard", effort: choice.effort };
  const model = provider.models.some((m) => m.id === choice.model) ? choice.model! : (defaultModel(provider)?.id ?? choice.model ?? "standard");
  const effort = choice.effort && effortsFor(provider, model).includes(choice.effort) ? choice.effort : defaultEffort(provider, model);
  // Fast stays on where the model has a faster tier, and where the hub
  // couldn't ask the plan which have one (nothing to say it hasn't).
  const tiersKnown = provider.models.some((m) => m.fast);
  const fast = !!choice.fast && (!tiersKnown || !!provider.models.find((m) => m.id === model)?.fast);
  const brain: Brain = effort ? { provider: provider.id, model, effort } : { provider: provider.id, model };
  return withRunsOn(fast ? { ...brain, fast } : brain, provider);
};

/** Where new agents start: one that can answer. The saved default while
 *  it's connected, else the first connected plan (Claude first), else any
 *  connected provider; with none connected (or none listed yet), the saved
 *  default, else the Claude plan, which `brainReady` then says can't. */
export const newAgentBrain = (saved: BrainChoice | null, providers: readonly Provider[]): Brain => {
  const listed = providers.length > 0;
  const savedWorks = !!saved && (!listed || !!byId(providers, saved.provider)?.connected);
  const pick =
    (savedWorks ? saved?.provider : undefined) ??
    providers.find((p) => p.group === "plan" && p.connected)?.id ??
    providers.find((p) => p.connected)?.id ??
    saved?.provider ??
    "claude-code";
  return resolveBrain(saved?.provider === pick ? saved : { provider: pick }, byId(providers, pick));
};

/** Whether `brain`'s provider is connected, so an agent on it can answer. */
export const brainReady = (brain: Pick<Brain, "provider">, providers: readonly Provider[]): boolean => !!byId(providers, brain.provider)?.connected;

/** The brain an agent's config is on, as it would run: a tier name or no
 *  model is its provider's default model, no effort the model's default
 *  effort, and no effort at all for a model without one.
 *  `fallback` (what the hub reports) fills in what the file doesn't say. */
export const brainOf = (
  source: string,
  providers: readonly Provider[],
  fallback: { provider?: string | null; model?: string | null } = {},
): Brain => {
  const llm = (parseDoc(source).llm ?? {}) as Doc;
  const configured = typeof llm.provider === "string" ? llm.provider : (fallback.provider ?? "claude-code");
  const named = typeof llm.default_model === "string" ? llm.default_model : null;
  const provider = entryOf(providers, configured, named);
  const providerId = provider?.id ?? configured;
  const model =
    named && !TIERS.has(named)
      ? named
      : ((provider && defaultModel(provider)?.id) ?? named ?? fallback.model ?? "standard");
  const effort = !provider
    ? typeof llm.effort === "string"
      ? llm.effort
      : undefined
    : effortsFor(provider, model).length === 0
      ? undefined
      : typeof llm.effort === "string"
        ? llm.effort
        : defaultEffort(provider, model);
  const base: Brain = effort ? { provider: providerId, model, effort } : { provider: providerId, model };
  const brain: Brain = llm.fast === true ? { ...base, fast: true } : base;
  return provider ? withRunsOn(brain, provider) : brain;
};

/** An agent's config thinking with `brain`; an effort is dropped where the
 *  brain has none. Anything else in the file stays. */
export const withBrain = (source: string, brain: Brain): string => {
  const doc = parseDoc(source);
  const llm: Doc = { ...((doc.llm ?? {}) as Doc), provider: brain.runsOn ?? brain.provider, default_model: brain.model };
  if (brain.effort) llm.effort = brain.effort;
  else delete llm.effort;
  if (brain.fast) llm.fast = true;
  else delete llm.fast;
  doc.llm = llm;
  return stringify(doc) + "\n";
};

/** A new agent's config: `brain`, and every rich block on unless the file
 *  already says otherwise. */
export const withDeskSettings = (source: string, brain: Brain): string => {
  const doc = parseDoc(withBrain(source, brain));
  doc.rich = { ...RICH, ...((doc.rich as object | undefined) ?? {}) };
  // A new local agent starts at Full access, asking only before what can't
  // be undone, said in its file.
  doc.computer = { access: "full", asks: "irreversible", ...((doc.computer as object | undefined) ?? {}) };
  // A new agent gets no connector until the person turns one on for it.
  const skills = (doc.skills as Record<string, unknown> | undefined) ?? {};
  doc.skills = { ...skills, enabled: Array.isArray(skills.enabled) ? skills.enabled : [] };
  return stringify(doc) + "\n";
};

export const isDefaultModel = (p: Provider | undefined, model: string): boolean => !!p && defaultModel(p)?.id === model;

/** Whether `effort` is what `model` runs at by default. */
export const isDefaultEffort = (p: Provider | undefined, effort: string | undefined, model?: string): boolean =>
  !!p && effort !== undefined && defaultEffort(p, model) === effort;

/** Whether the brain is on its provider's defaults: the default model, at
 *  that model's default effort (or a model with no effort). */
export const isDefaultBrain = (p: Provider | undefined, brain: Brain): boolean =>
  !!p && isDefaultModel(p, brain.model) && (effortsFor(p, brain.model).length === 0 || isDefaultEffort(p, brain.effort, brain.model));

export const modelOf = (p: Provider | undefined, model: string) => p?.models.find((m) => m.id === model);

export const modelName = (p: Provider | undefined, model: string): string => modelOf(p, model)?.name ?? model;

export const effortShort = (effort: string): string => EFFORTS[effort]?.short ?? "";

/** Whether the brain asks a faster tier its model has. */
const runsFast = (brain: Brain, p: Provider | undefined): boolean => !!brain.fast && !!modelOf(p, brain.model)?.fast;

/** "Sonnet 5.5 · Medium effort" */
export const brainLine = (brain: Brain, p: Provider | undefined): string =>
  [modelName(p, brain.model), brain.effort && `${effortName(brain.effort)} effort`, runsFast(brain, p) && "Fast"].filter(Boolean).join(" · ");

/** "Sonnet 5.5 on your Claude plan · Medium effort" */
export const brainOn = (brain: Brain, p: Provider | undefined): string =>
  `${modelName(p, brain.model)} on your ${p?.name ?? brain.provider}${brain.effort ? ` · ${effortName(brain.effort)} effort` : ""}${runsFast(brain, p) ? " · Fast" : ""}`;

/** "Ledger will use Sonnet 5.5 on your Claude plan · Medium effort" */
export const brainSummary = (who: string, brain: Brain, p: Provider | undefined): string => `${who} will use ${brainOn(brain, p)}`;
