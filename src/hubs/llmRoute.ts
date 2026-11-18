// What a person's work on a workspace runs on: the workspace's own models or
// one of their own subscriptions, for every agent there (`/api/me/llm-route`)
// or for one agent alone (`/api/me/agents/{id}/llm-route`), as the hub's
// My Settings › Models and agent pages set it.

import { jsonBody, pairedHub, type HubRef } from "../hub/net";

export type RouteKind = "claude-code" | "codex" | "devin";
export type RouteFallback = "wait" | "hub";

export interface PersonalRoute {
  kind: RouteKind;
  fallback: RouteFallback;
}

/** A person's setting for one agent: their own route, or the workspace's. */
export type AgentRoute = PersonalRoute | "hub";

/** One kind as the person may pick it; `refused` says why not. */
export interface RouteOption {
  kind: RouteKind;
  refused: string | null;
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
  kind
    ? `Your conversations, and the tool results in them, go to ${PROVIDERS[kind]}.`
    : `Your conversations stay on ${workspace}’s own models.`;

interface Raw {
  available?: boolean;
  allow?: RouteKind[];
  route?: unknown;
  every_agent?: PersonalRoute | null;
  effective?: PersonalRoute | null;
  options?: { kind: RouteKind; refused?: string | null }[];
}

const NOT_YET = "this workspace doesn’t say yet whether it can run your work on this";

/** Every kind as the person may pick it. A workspace from before the
 *  hub listed its reasons only says which kinds it allows: one it allows
 *  is offered, and the hub's own check answers if it can't be. */
export const optionsOf = (raw: Raw): RouteOption[] =>
  raw.options
    ? raw.options.map((o) => ({ kind: o.kind, refused: o.refused ?? null }))
    : KINDS.map((kind) => ({ kind, refused: raw.allow?.includes(kind) ? null : NOT_YET }));

/** What a workspace from before `/api/me/llm-route` answers. */
const MISSING: Raw & { missing: true } = { missing: true };

export const answer = async (res: Response): Promise<Raw & { missing?: true }> => {
  if (res.status === 404 || res.status === 405) return MISSING;
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
    raw.effective !== undefined
      ? raw.effective
      : raw.route === "hub"
        ? null
        : ((raw.route as PersonalRoute | null) ?? raw.every_agent ?? null),
  options: optionsOf(raw),
});

export const myRoute = async (hub: HubRef): Promise<RouteView> =>
  view(await answer(await pairedHub(hub).fetch("GET", "/api/me/llm-route")));

export const setMyRoute = async (hub: HubRef, route: PersonalRoute | null): Promise<RouteView> =>
  view(await answer(await pairedHub(hub).fetch("PUT", "/api/me/llm-route", jsonBody({ route }))));

export const myAgentRoute = async (hub: HubRef, agentId: string): Promise<AgentRouteView> =>
  agentView(await answer(await pairedHub(hub).fetch("GET", agentPath(agentId))));

export const setMyAgentRoute = async (hub: HubRef, agentId: string, route: AgentRoute | null): Promise<AgentRouteView> =>
  agentView(await answer(await pairedHub(hub).fetch("PUT", agentPath(agentId), jsonBody({ route }))));
