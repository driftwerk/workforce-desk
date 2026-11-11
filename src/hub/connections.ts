import { hubCall } from "./client";
import type { HubRef } from "./net";

/** The services agents on this computer can be given, as the local hub's
 *  `GET /api/desk/connections` lists them, asked as the person: the keys
 *  are in the vault at the person's own tiers, and never come back. A
 *  service holds several connections (two Jira sites, work and personal
 *  email), each with a name the person gave it. */

/** How a connector is signed in to: its fields, GitHub's device sign-in
 *  (or a token in the fields), or Google's sign-in on the person's own
 *  OAuth client. */
export type SignIn = "fields" | "github" | "google";

export interface ConnectorField {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder: string;
}

/** `connected`, or what its last check found wrong. */
export type ConnectionStatus = "connected" | "needs_reconnect" | "failing";

/** Where a connection is kept: for all the person's agents, or one. */
export type Level = "all" | "agent";

export interface UsedBy {
  agent: string;
  name: string;
  /** `mine`: the person's connection for all their agents; `own`: just
   *  this agent's. */
  connection: "mine" | "own";
}

export interface Connection {
  /** What Desk names it by in a request. Never shown. */
  id: string;
  /** The name the person gave it: "Acme", "Work". */
  name: string;
  /** Where it is, for a service with a site: `acme.atlassian.net`. */
  site: string | null;
  level: Level;
  agent: string | null;
  agentName: string | null;
  /** Whose account the check found: an email, a login, a workspace. */
  account: string | null;
  status: ConnectionStatus;
  /** The service's own words when it isn't connected. */
  detail: string | null;
  connectedAt: string | null;
  /** Null: kept before Desk checked it. */
  checkedAt: string | null;
  /** The vault tier it is kept at. */
  source: string;
  /** The agents it reaches. */
  usedBy: UsedBy[];
}

export interface Connector {
  id: string;
  name: string;
  about: string;
  signIn: SignIn;
  fields: ConnectorField[];
  /** Whether its sign-in can start (GitHub's app, the person's Google
   *  client). */
  signInReady: boolean;
  /** It holds more than one connection (Slack holds one). */
  several: boolean;
  /** What a new connection's name should be, as the form says. */
  nameHint: string;
  connections: Connection[];
  usedBy: UsedBy[];
}

/** Where a new connection is kept. */
export type At = { level: "all" } | { level: "agent"; agent: string };

/** What a disconnect left: a key still kept at another tier (an older one
 *  saved for the whole hub), and what to tell the person. */
export interface Disconnected {
  stillKept: string | null;
  note: string | null;
}

export interface Started {
  flow: string;
  /** Google: the page to open. */
  url: string | null;
  /** GitHub: the code to type at `verificationUri`. */
  userCode: string | null;
  verificationUri: string | null;
  expiresIn: number;
}

export type FlowState =
  | { state: "waiting" }
  | { state: "connected"; account: string }
  | { state: "cancelled" }
  | { state: "expired" }
  | { state: "failed"; error: string };

/** Every connector, and the hub's other built-in adapters: an agent with
 *  no connectors chosen yet has those too. */
export interface Listing {
  connectors: Connector[];
  adapters: string[];
}

/** One connection, as an agent's Connectors shows it. */
export interface Pick {
  id: string;
  name: string;
  site: string | null;
  account: string | null;
  /** `all`: the person's for all their agents; `agent`: this agent's own. */
  level: Level;
  status: ConnectionStatus;
  /** The agent uses it. */
  picked: boolean;
  /** It takes the agent's writes. */
  write: boolean;
  /** The one a request that doesn't say goes to. */
  default: boolean;
}

/** One service, as an agent's Connectors shows it. */
export interface ServicePicks {
  id: string;
  name: string;
  several: boolean;
  /** Each connection takes writes on its own; otherwise all together. */
  readOnlyEach: boolean;
  /** Its connections are chosen one by one already. */
  chosen: boolean;
  connections: Pick[];
}

/** The connections of one service an agent is to use. */
export interface PicksChange {
  service: string;
  connections: { id: string; write: boolean }[];
  default: string | null;
}

/** Where a step of a setup is. `waiting`: on the person. */
export type StepState = "todo" | "current" | "waiting" | "done" | "failed";

export interface SetupStep {
  id: string;
  label: string;
  state: StepState;
  note: string | null;
}

/** An agent setting a connection up itself, as the hub keeps it: the card
 *  the chat shows. */
export interface Setup {
  id: string;
  agent: string;
  session: string | null;
  service: string;
  serviceName: string;
  name: string;
  site: string | null;
  steps: SetupStep[];
  startedAt: string;
  connected: { connection: string; account: string; onFor: string | null; write: boolean | null } | null;
}

export interface ConnectionsApi {
  list(): Promise<Listing>;
  connect(id: string, at: At, fields: Record<string, string>, name?: string): Promise<Connection>;
  reconnect(id: string, connection: string, fields: Record<string, string>): Promise<Connection>;
  rename(id: string, connection: string, name: string): Promise<Connection>;
  test(id: string, connection: string): Promise<Connection>;
  disconnect(id: string, connection: string): Promise<Disconnected>;
  saveGoogleClient(clientId: string, clientSecret: string): Promise<void>;
  start(id: string, at: At, name?: string): Promise<Started>;
  flow(flow: string): Promise<FlowState>;
  cancel(flow: string): Promise<void>;
  picks(agent: string): Promise<ServicePicks[]>;
  setPicks(agent: string, change: PicksChange): Promise<ServicePicks[]>;
  setups(agent?: string): Promise<Setup[]>;
  signedIn(setup: string): Promise<Setup>;
}

const path = (id: string, connection?: string) =>
  `/api/desk/connections/${encodeURIComponent(id)}${connection ? `/${encodeURIComponent(connection)}` : ""}`;

/** Connections on `hub`, asked as the person. */
export const connectionsOf = (hub: HubRef): ConnectionsApi => ({
  list: async () => {
    const got = await hubCall<Partial<Listing>>(hub, "GET", "/api/desk/connections");
    return { connectors: got.connectors ?? [], adapters: got.adapters ?? [] };
  },
  connect: async (id, at, fields, name) =>
    (await hubCall<{ connection: Connection }>(hub, "POST", path(id), { ...at, fields, ...(name ? { name } : {}) })).connection,
  reconnect: async (id, connection, fields) =>
    (await hubCall<{ connection: Connection }>(hub, "POST", path(id, connection), { fields })).connection,
  rename: async (id, connection, name) =>
    (await hubCall<{ connection: Connection }>(hub, "PATCH", path(id, connection), { name })).connection,
  test: async (id, connection) =>
    (await hubCall<{ connection: Connection }>(hub, "POST", `${path(id, connection)}/test`, {})).connection,
  disconnect: async (id, connection) =>
    (await hubCall<Disconnected | undefined>(hub, "DELETE", path(id, connection))) ?? { stillKept: null, note: null },
  saveGoogleClient: (clientId, clientSecret) =>
    hubCall<void>(hub, "POST", "/api/desk/connections/google/client", { client_id: clientId, client_secret: clientSecret }),
  start: (id, at, name) => hubCall<Started>(hub, "POST", `${path(id)}/oauth/start`, { ...at, ...(name ? { name } : {}) }),
  flow: (flow) => hubCall<FlowState>(hub, "GET", `/api/desk/connection-flows/${encodeURIComponent(flow)}`),
  cancel: (flow) => hubCall<void>(hub, "DELETE", `/api/desk/connection-flows/${encodeURIComponent(flow)}`),
  picks: async (agent) =>
    (await hubCall<{ services?: ServicePicks[] }>(hub, "GET", `/api/desk/agents/${encodeURIComponent(agent)}/connections`)).services ?? [],
  setPicks: async (agent, change) =>
    (await hubCall<{ services?: ServicePicks[] }>(hub, "PUT", `/api/desk/agents/${encodeURIComponent(agent)}/connections`, change)).services ??
    [],
  setups: async (agent) =>
    (await hubCall<{ setups?: Setup[] }>(hub, "GET", `/api/desk/connection-setups${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`))
      .setups ?? [],
  signedIn: async (setup) =>
    (await hubCall<{ setup: Setup }>(hub, "POST", `/api/desk/connection-setups/${encodeURIComponent(setup)}/signed-in`, {})).setup,
});

/** "Allan and Ben" */
export const names = (list: string[]): string =>
  list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;

/** The connections for all the person's agents. */
export const forAll = (c: Connector): Connection[] => c.connections.filter((x) => x.level === "all");

/** The connections kept just for one agent. */
export const agentOnly = (c: Connector): Connection[] => c.connections.filter((x) => x.level === "agent");

/** The services an agent can set up itself, in Desk's own browser. */
export const SET_UP_BY_AGENT = new Set(["jira", "linear", "datadog", "metabase", "github"]);

/** What a connection's status reads as. */
export const statusLine = (x: Pick | Connection): string => {
  switch (x.status) {
    case "connected":
      return "Connected";
    case "needs_reconnect":
      return "Needs signing in again";
    case "failing":
      return "Not answering";
  }
};

/** Whom a connection is for, in the person's words. */
export const forWhom = (x: Connection): string => (x.level === "all" ? "All my agents" : `Just ${x.agentName ?? "one agent"}`);

/** What a request asking an agent to set a service up says. */
export const setUpRequest = (service: string, forWhom: "me" | "all", name?: string): string =>
  `Set up ${service}${name ? ` (${name})` : ""} ${forWhom === "all" ? "for all my agents" : "for yourself"}: make the key in your browser and keep it in the vault. I’ll sign in when you ask.`;
