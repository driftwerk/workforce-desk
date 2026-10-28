import { parse, stringify } from "smol-toml";
import { defaultEffort, defaultModel, effortName, EFFORTS, type Provider } from "../hub/providers";

/** How an agent thinks: its provider, a model of that provider and, where
 *  the provider has one, an effort. */
export interface Brain {
  provider: string;
  model: string;
  effort?: string;
}

/** Desk's saved default for new agents: unset parts mean that provider's
 *  default. */
export interface BrainChoice {
  provider: string;
  model?: string;
  effort?: string;
}

/** What older agents' configs name instead of a model. */
const TIERS = new Set(["standard", "powerful", "cheap"]);

const RICH = { tables: true, charts: true, forms: true, maps: true, diagrams: true, images: true };

type Doc = Record<string, unknown>;

const parseDoc = (source: string): Doc => (source.trim() ? (parse(source) as Doc) : {});

const byId = (providers: readonly Provider[], id: string): Provider | undefined => providers.find((p) => p.id === id);

/** `choice` made whole against its provider: a model or effort the provider
 *  doesn't offer becomes its default; no effort where it has none. Without
 *  the provider's list, the choice as given (a tier name for the model). */
export const resolveBrain = (choice: BrainChoice, provider: Provider | undefined): Brain => {
  if (!provider) return { provider: choice.provider, model: choice.model ?? "standard", effort: choice.effort };
  const model = provider.models.some((m) => m.id === choice.model) ? choice.model! : (defaultModel(provider)?.id ?? choice.model ?? "standard");
  const effort = choice.effort && provider.efforts.includes(choice.effort) ? choice.effort : defaultEffort(provider);
  return effort ? { provider: provider.id, model, effort } : { provider: provider.id, model };
};

/** Where new agents start: the saved default, else the first connected
 *  plan (Claude first), else any connected provider, else the Claude plan. */
export const newAgentBrain = (saved: BrainChoice | null, providers: readonly Provider[]): Brain => {
  const pick =
    saved?.provider ??
    providers.find((p) => p.group === "plan" && p.connected)?.id ??
    providers.find((p) => p.connected)?.id ??
    "claude-code";
  return resolveBrain(saved ?? { provider: pick }, byId(providers, pick));
};

/** The brain an agent's config is on, as it would run: a tier name or no
 *  model is its provider's default model, no effort its default effort.
 *  `fallback` (what the hub reports) fills in what the file doesn't say. */
export const brainOf = (
  source: string,
  providers: readonly Provider[],
  fallback: { provider?: string | null; model?: string | null } = {},
): Brain => {
  const llm = (parseDoc(source).llm ?? {}) as Doc;
  const providerId = typeof llm.provider === "string" ? llm.provider : (fallback.provider ?? "claude-code");
  const provider = byId(providers, providerId);
  const named = typeof llm.default_model === "string" ? llm.default_model : null;
  const model =
    named && !TIERS.has(named)
      ? named
      : ((provider && defaultModel(provider)?.id) ?? named ?? fallback.model ?? "standard");
  const effort = !provider
    ? typeof llm.effort === "string"
      ? llm.effort
      : undefined
    : provider.efforts.length === 0
      ? undefined
      : typeof llm.effort === "string"
        ? llm.effort
        : defaultEffort(provider);
  return effort ? { provider: providerId, model, effort } : { provider: providerId, model };
};

/** An agent's config thinking with `brain`; an effort is dropped where the
 *  brain has none. Anything else in the file stays. */
export const withBrain = (source: string, brain: Brain): string => {
  const doc = parseDoc(source);
  const llm: Doc = { ...((doc.llm ?? {}) as Doc), provider: brain.provider, default_model: brain.model };
  if (brain.effort) llm.effort = brain.effort;
  else delete llm.effort;
  doc.llm = llm;
  return stringify(doc) + "\n";
};

/** A new agent's config: `brain`, and every rich block on unless the file
 *  already says otherwise. */
export const withDeskSettings = (source: string, brain: Brain): string => {
  const doc = parseDoc(withBrain(source, brain));
  doc.rich = { ...RICH, ...((doc.rich as object | undefined) ?? {}) };
  return stringify(doc) + "\n";
};

export const isDefaultModel = (p: Provider | undefined, model: string): boolean => !!p && defaultModel(p)?.id === model;

export const isDefaultEffort = (p: Provider | undefined, effort: string | undefined): boolean =>
  !!p && effort !== undefined && defaultEffort(p) === effort;

export const modelOf = (p: Provider | undefined, model: string) => p?.models.find((m) => m.id === model);

export const modelName = (p: Provider | undefined, model: string): string => modelOf(p, model)?.name ?? model;

export const effortShort = (effort: string): string => EFFORTS[effort]?.short ?? "";

/** "Sonnet 5.5 · Medium effort" */
export const brainLine = (brain: Brain, p: Provider | undefined): string =>
  [modelName(p, brain.model), brain.effort && `${effortName(brain.effort)} effort`].filter(Boolean).join(" · ");

/** "Sonnet 5.5 on your Claude plan · Medium effort" */
export const brainOn = (brain: Brain, p: Provider | undefined): string =>
  `${modelName(p, brain.model)} on your ${p?.name ?? brain.provider}${brain.effort ? ` · ${effortName(brain.effort)} effort` : ""}`;

/** "Ledger will use Sonnet 5.5 on your Claude plan · Medium effort" */
export const brainSummary = (who: string, brain: Brain, p: Provider | undefined): string => `${who} will use ${brainOn(brain, p)}`;
