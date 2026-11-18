// What a person's work on a workspace runs on: the workspace's own models or
// one of their own subscriptions, for every agent there (`/api/me/llm-route`)
// or for one agent alone (`/api/me/agents/{id}/llm-route`), as the hub's
// My Settings › Models and agent pages set it.

import { jsonBody, pairedHub, type HubRef } from "../hub/net";

export type RouteKind = "claude-code" | "codex" | "devin";
export type RouteFallback = "wait" | "hub";

/** The models a person's route runs by kind of work, in an agent's own
 *  words (`model_preferences.conversation`, `light_model`, `heavy_model`):
 *  a tier, one of the route's models, or for background work `chat`.
 *  Unset is the route's default. */
export interface RouteModels {
  model_preferences?: { conversation?: string };
  light_model?: string;
  heavy_model?: string;
}

export interface PersonalRoute extends RouteModels {
  kind: RouteKind;
  fallback: RouteFallback;
}

export type RouteWork = "conversation" | "light" | "heavy";

/** What each kind of work runs when nothing is chosen, as a picker says it. */
export interface RouteDefaults {
  conversation: string;
  light: string;
  heavy: string;
}

/** The model `route` runs for `work` as set; `undefined` is the default. */
export const chosenModel = (route: RouteModels | null | undefined, work: RouteWork): string | undefined => {
  if (!route) return undefined;
  const set = work === "conversation" ? route.model_preferences?.conversation : route[`${work}_model`];
  return set?.trim() || undefined;
};

/** `route` with `work` on `model`; `undefined` is back on the default. */
export const withModel = <R extends object>(route: R, work: RouteWork, model: string | undefined): R & RouteModels => {
  const next = { ...(route as R & RouteModels) };
  if (work === "conversation") {
    if (model) next.model_preferences = { conversation: model };
    else delete next.model_preferences;
  } else if (model) next[`${work}_model`] = model;
  else delete next[`${work}_model`];
  return next;
};

/** What of `route` to keep when it changes to `kind`: its models on the
 *  same kind, none on another provider's. */
export const keptModels = (route: PersonalRoute | null | undefined, kind: RouteKind): RouteModels => {
  if (!route || route.kind !== kind) return {};
  let kept: RouteModels = {};
  for (const work of ["conversation", "light", "heavy"] as const) kept = withModel(kept, work, chosenModel(route, work));
  return kept;
};

/** A person's setting for one agent: their own route, or the workspace's. */
export type AgentRoute = PersonalRoute | "hub";

/** One kind as the person may pick it; `refused` says why not. */
export interface RouteOption {
  kind: RouteKind;
  refused: string | null;
  /** The models a route of this kind can run beside the tiers; absent on a
   *  workspace from before people chose their route's models. */
  models?: string[];
  defaults?: RouteDefaults;
}

export interface RouteView {
  available: boolean;
  /** The workspace is from before people could pick their route. */
  missing?: boolean;
  route: PersonalRoute | null;
  options: RouteOption[];
}

export interface AgentRouteView {
  available: boolean;
  missing?: boolean;
  route: AgentRoute | null;
  everyAgent: PersonalRoute | null;
  effective: PersonalRoute | null;
  options: RouteOption[];
}

export const KINDS: RouteKind[] = ["claude-code", "codex", "devin"];

export const ROUTE_TITLES: Record<RouteKind, string> = {
  "claude-code": "My Claude",
  codex: "My ChatGPT (Codex)",
  devin: "My Devin",
};

const PROVIDERS: Record<RouteKind, string> = {
  "claude-code": "Anthropic, under your own Claude account",
  codex: "OpenAI, under your own ChatGPT account",
  devin: "Cognition, under your own Devin account",
};

/** The line saying where a person's conversations go; `null` is the workspace's models. */
export const whereDataGoes = (kind: RouteKind | null, workspace: string): string =>
  kind ? `Your conversations, and the tool results in them, go to ${PROVIDERS[kind]}.` : `Your conversations stay on ${workspace}’s own models.`;

interface Raw {
  available?: boolean;
  allow?: RouteKind[];
  route?: unknown;
  every_agent?: PersonalRoute | null;
  effective?: PersonalRoute | null;
  options?: {
    kind: RouteKind;
    refused?: string | null;
    models?: string[];
    defaults?: RouteDefaults;
  }[];
}

const NOT_YET = "this workspace doesn’t say yet whether it can run your work on this";

/** Every kind as the person may pick it. A workspace from before the
 *  hub listed its reasons only says which kinds it allows: one it allows
 *  is offered, and the hub's own check answers if it can't be. */
export const optionsOf = (raw: Raw): RouteOption[] =>
  raw.options
    ? raw.options.map((o) => ({
        kind: o.kind,
        refused: o.refused ?? null,
        ...(o.models ? { models: o.models } : {}),
        ...(o.defaults ? { defaults: o.defaults } : {}),
      }))
    : KINDS.map((kind) => ({
        kind,
        refused: raw.allow?.includes(kind) ? null : NOT_YET,
      }));

/** What a workspace from before `/api/me/llm-route` answers. */
const MISSING: Raw & { missing: true } = { missing: true };

export const answer = async (res: Response, read = false): Promise<Raw & { missing?: true }> => {
  // Only a read can tell an older workspace: a save there that misses is
  // an error to show.
  if (read && (res.status === 404 || res.status === 405)) return MISSING;
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Raw & { error?: string }) : {};
  if (!res.ok) throw new Error(body.error ?? `The workspace answered ${res.status}.`);
  return body;
};

const agentPath = (agentId: string) => `/api/me/agents/${encodeURIComponent(agentId)}/llm-route`;

const view = (raw: Raw & { missing?: true }): RouteView => ({
  available: !!raw.available,
  missing: raw.missing,
  route: (raw.route as PersonalRoute | null) ?? null,
  options: optionsOf(raw),
});

export const agentView = (raw: Raw & { missing?: true }): AgentRouteView => ({
  available: !!raw.available,
  missing: raw.missing,
  route: (raw.route as AgentRoute | null) ?? null,
  everyAgent: raw.every_agent ?? null,
  // A workspace that doesn't say: the agent's own setting, else the
  // every-agent one, as the narrower wins.
  effective:
    raw.effective !== undefined ? raw.effective : raw.route === "hub" ? null : ((raw.route as PersonalRoute | null) ?? raw.every_agent ?? null),
  options: optionsOf(raw),
});

export const myRoute = async (hub: HubRef): Promise<RouteView> => view(await answer(await pairedHub(hub).fetch("GET", "/api/me/llm-route"), true));

export const setMyRoute = async (hub: HubRef, route: PersonalRoute | null): Promise<RouteView> =>
  view(await answer(await pairedHub(hub).fetch("PUT", "/api/me/llm-route", jsonBody({ route }))));

export const myAgentRoute = async (hub: HubRef, agentId: string): Promise<AgentRouteView> =>
  agentView(await answer(await pairedHub(hub).fetch("GET", agentPath(agentId)), true));

export const setMyAgentRoute = async (hub: HubRef, agentId: string, route: AgentRoute | null): Promise<AgentRouteView> =>
  agentView(await answer(await pairedHub(hub).fetch("PUT", agentPath(agentId), jsonBody({ route }))));
