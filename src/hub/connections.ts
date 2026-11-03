import { hubCall } from "./client";
import type { HubRef } from "./net";

/** The services agents on this computer can be given, as the local hub's
 *  `GET /api/desk/connections` lists them, asked as the person: the keys
 *  are in the vault at the person's own tiers, and never come back. */

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

export interface Connection {
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
}

export interface UsedBy {
  agent: string;
  name: string;
  /** `mine`: the person's connection for all their agents; `own`: just
   *  this agent's. */
  connection: "mine" | "own";
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
  connections: Connection[];
  usedBy: UsedBy[];
}

/** Which connection a request is about. */
export type At = { level: "all" } | { level: "agent"; agent: string };

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

export interface ConnectionsApi {
  list(): Promise<Listing>;
  connect(id: string, at: At, fields: Record<string, string>): Promise<Connection>;
  test(id: string, at: At): Promise<Connection>;
  disconnect(id: string, at: At): Promise<void>;
  saveGoogleClient(clientId: string, clientSecret: string): Promise<void>;
  start(id: string, at: At): Promise<Started>;
  flow(flow: string): Promise<FlowState>;
  cancel(flow: string): Promise<void>;
}

const query = (at: At): string =>
  new URLSearchParams(at.level === "agent" ? { level: "agent", agent: at.agent } : { level: "all" }).toString();

/** Connections on `hub`, asked as the person. */
export const connectionsOf = (hub: HubRef): ConnectionsApi => ({
  list: async () => {
    const got = await hubCall<Partial<Listing>>(hub, "GET", "/api/desk/connections");
    return { connectors: got.connectors ?? [], adapters: got.adapters ?? [] };
  },
  connect: async (id, at, fields) =>
    (await hubCall<{ connection: Connection }>(hub, "POST", `/api/desk/connections/${encodeURIComponent(id)}`, { ...at, fields }))
      .connection,
  test: async (id, at) =>
    (await hubCall<{ connection: Connection }>(hub, "POST", `/api/desk/connections/${encodeURIComponent(id)}/test`, at)).connection,
  disconnect: (id, at) => hubCall<void>(hub, "DELETE", `/api/desk/connections/${encodeURIComponent(id)}?${query(at)}`),
  saveGoogleClient: (clientId, clientSecret) =>
    hubCall<void>(hub, "POST", "/api/desk/connections/google/client", { client_id: clientId, client_secret: clientSecret }),
  start: (id, at) => hubCall<Started>(hub, "POST", `/api/desk/connections/${encodeURIComponent(id)}/oauth/start`, at),
  flow: (flow) => hubCall<FlowState>(hub, "GET", `/api/desk/connection-flows/${encodeURIComponent(flow)}`),
  cancel: (flow) => hubCall<void>(hub, "DELETE", `/api/desk/connection-flows/${encodeURIComponent(flow)}`),
});

/** "Allan and Ben" */
export const names = (list: string[]): string =>
  list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;

/** The connection for all the person's agents, if there is one. */
export const mine = (c: Connector): Connection | undefined => c.connections.find((x) => x.level === "all");

/** The connections kept just for one agent. */
export const agentOnly = (c: Connector): Connection[] => c.connections.filter((x) => x.level === "agent");

/** What a connection's status reads as. */
export const statusLine = (x: Connection): string => {
  switch (x.status) {
    case "connected":
      return x.account ? `Connected as ${x.account}` : "Connected";
    case "needs_reconnect":
      return "Needs reconnecting";
    case "failing":
      return "Not answering";
  }
};
