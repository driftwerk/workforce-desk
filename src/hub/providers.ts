/** What an agent on this Mac can think with, as the hub's
 *  `GET /api/desk/providers` lists it. */

export type ProviderGroup = "plan" | "key" | "local";

export interface ProviderField {
  name: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  required?: boolean;
  /** A whole file's worth, like a service-account key. */
  multiline?: boolean;
}

export interface ProviderConnect {
  /** `login`: the plan's own one-click sign-in; `fields`: keys or an
   *  address; `probe`: Desk looks for it (an address can be given). */
  kind: "login" | "fields" | "probe";
  fields: ProviderField[];
  hint?: string;
}

export interface ProviderModel {
  id: string;
  name: string;
  description: string;
  default: boolean;
  /** What the agent's config names as its provider to run this model
   *  (`bedrock:anthropic`); the entry's id when absent. */
  provider?: string;
  /** This model's own efforts, over the provider's; empty: it has none. */
  efforts?: string[];
  /** This model's own default effort, over the provider's. */
  defaultEffort?: string | null;
}

export interface Provider {
  id: string;
  name: string;
  group: ProviderGroup;
  description: string;
  connected: boolean;
  connect: ProviderConnect;
  models: ProviderModel[];
  /** Empty: the provider has no effort setting. */
  efforts: string[];
  defaultEffort?: string | null;
}

export const GROUPS: { id: ProviderGroup; label: string }[] = [
  { id: "plan", label: "Your plans" },
  { id: "key", label: "API keys" },
  { id: "local", label: "On this Mac" },
];

export const EFFORTS: Record<string, { name: string; short: string; long: string }> = {
  low: { name: "Low", short: "quickest, least thinking", long: "Answers quickly with the least thinking." },
  medium: { name: "Medium", short: "balanced speed and depth", long: "Balanced speed and depth." },
  high: { name: "High", short: "thinks longer on hard problems", long: "Thinks longer before answering hard problems." },
  xhigh: { name: "X-High", short: "extended reasoning", long: "Extended reasoning for the hardest problems." },
  max: {
    name: "Max",
    short: "thinks as long as it needs",
    long: "Thinks as long as it needs. Slowest, and uses your plan fastest.",
  },
};

export const effortName = (e: string): string => EFFORTS[e]?.name ?? e;

/** The one-liner under the effort control, saying so when it's the
 *  default for that model. */
export const effortLine = (p: Provider, e: string, model?: string): string =>
  `${EFFORTS[e]?.long ?? ""}${e === defaultEffort(p, model) ? " The default." : ""}`.trim();

/** The plan sign-in each plan provider uses (`src-tauri/src/logins`). */
export const PLAN_OF: Record<string, "claude" | "chatgpt"> = { "claude-code": "claude", chatgpt: "chatgpt" };

export const defaultModel = (p: Provider): ProviderModel | undefined => p.models.find((m) => m.default) ?? p.models[0];

const modelEntry = (p: Provider, model: string | undefined): ProviderModel | undefined =>
  model === undefined ? undefined : p.models.find((m) => m.id === model);

/** The efforts `model` offers: its own where it says, else the provider's.
 *  Empty: no effort setting. */
export const effortsFor = (p: Provider, model?: string): string[] => modelEntry(p, model)?.efforts ?? p.efforts;

/** The effort `model` runs at when none is chosen: its own default, else
 *  the provider's, else its first; none where it has no efforts. */
export const defaultEffort = (p: Provider, model?: string): string | undefined => {
  const efforts = effortsFor(p, model);
  const own = modelEntry(p, model)?.defaultEffort;
  return [own, p.defaultEffort].find((e): e is string => !!e && efforts.includes(e)) ?? efforts[0];
};
