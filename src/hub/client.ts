import { preview } from "../preview";
import type { Provider } from "./providers";
import type {
  ActivityFilter,
  ActivityPage,
  Decision,
  DeskEvent,
  Manager,
  NewSession,
  NewTerminal,
  Overview,
  Room,
  RoomMemberRef,
  RoomMessage,
  Session,
  Suggestion,
  TerminalInfo,
} from "./types";
import { hubFetch } from "./net";

export interface HubConnection {
  url: string;
  token: string;
}

/** One saved version of an agent's file, newest first in a list. */
export interface Revision {
  rev: number;
  /** Only when one revision is fetched. */
  content?: string;
  /** `web`, `restore`, `agent_tool`, `oob`, `seed`, … */
  edited_via: string;
  edited_by: string | null;
  restored_from: number | null;
  created_at: string;
}

/** `GET /api/agents/{id}/memory/summary`. */
export interface MemorySummaryWire {
  memories: number;
  lessons: number;
  tidied_at: string | null;
}

/** `GET /api/agents/{id}/heartbeat`. */
export interface AgentHeartbeat {
  enabled: boolean;
  interval_secs: number;
  quiet_start: string | null;
  quiet_end: string | null;
  /** Things on the check-in list (HEARTBEAT.md). */
  items: number;
  last_checked: string | null;
  /** Whether the last check-in needed the person; null before any. */
  needed_you: boolean | null;
  last_error: string | null;
}

/** What a hub without a route is taken to have said. */
const NO_ROUTE = "This hub doesn’t have that yet.";

/** One key of Desk's state on a hub. */
export interface StateRow {
  key: string;
  value: unknown;
  updatedAt: string | null;
}

const stateRow = (x: unknown): StateRow | null => {
  if (!x || typeof x !== "object") return null;
  const r = x as { key?: unknown; value?: unknown; updatedAt?: unknown; updated_at?: unknown };
  if (typeof r.key !== "string" || !("value" in r)) return null;
  const at = r.updatedAt ?? r.updated_at;
  return { key: r.key, value: r.value, updatedAt: typeof at === "string" ? at : null };
};

/** A listing (`[{key, value, updatedAt}]`, or the same under `entries`). A
 *  JSON answer that's no listing is a hub without the route (its `error`);
 *  one whose rows Desk can't read is said, not taken as an empty store. */
export const stateRows = (body: unknown): StateRow[] => {
  const o = body as Record<string, unknown> | null;
  const list = Array.isArray(body) ? body : o?.entries;
  if (!Array.isArray(list)) throw new HubError(404, NO_ROUTE);
  const rows = list.flatMap((x) => stateRow(x) ?? []);
  if (rows.length < list.length) {
    throw new HubError(502, `The hub's Desk state listing has ${list.length - rows.length} rows Desk can't read.`);
  }
  return rows;
};

export class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What a hub said when it refused: its JSON `error` when it gives one,
 *  else a plain-text body as written (never JSON or a web page), else the
 *  status line. */
const refusal = async (res: Response): Promise<HubError> => {
  const text = (await res.text().catch(() => "")).trim();
  let message = text.startsWith("<") ? "" : text;
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object") {
      const error = (body as { error?: unknown }).error;
      message = typeof error === "string" && error.trim() ? error : "";
    }
  } catch {
    /* a plain-text body */
  }
  return new HubError(res.status, message || res.statusText || "The hub refused that.");
};

const wsUrl = (base: string, path: string, token: string): string => {
  const u = new URL(path, base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("token", token);
  return u.toString();
};

export class DeskHub {
  constructor(private readonly conn: HubConnection) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await hubFetch(new URL(path, this.conn.url), {
      method,
      headers: {
        authorization: `Bearer ${this.conn.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await refusal(res);
    if (res.status === 204) return undefined as T;
    // A hub without this route answers with its web page, not a 404.
    if (!(res.headers.get("content-type") ?? "").includes("json")) {
      throw new HubError(404, NO_ROUTE);
    }
    return (await res.json()) as T;
  }

  /** A Desk route; in the browser preview, the dev bridge answers the ones
   *  the running hub doesn't have yet. */
  private async desk<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.call<T>(method, path, body);
    } catch (e) {
      if (!preview || !(e instanceof HubError) || e.status !== 404) throw e;
      const { devHub } = await import("../devBridge");
      return devHub<T>(method, path, body);
    }
  }

  private async text(path: string): Promise<string> {
    const res = await hubFetch(new URL(path, this.conn.url), { headers: { authorization: `Bearer ${this.conn.token}` } });
    if (!res.ok) throw await refusal(res);
    return res.text();
  }

  private async putText(path: string, text: string): Promise<void> {
    const res = await hubFetch(new URL(path, this.conn.url), {
      method: "PUT",
      headers: { authorization: `Bearer ${this.conn.token}`, "content-type": "text/plain" },
      body: text,
    });
    if (!res.ok) throw await refusal(res);
  }

  sessions = (): Promise<Session[]> => this.call("GET", "/api/desk/sessions");
  start = (s: NewSession): Promise<Session> => this.call("POST", "/api/desk/sessions", s);
  update = (id: string, patch: { name?: string; goal?: string; approvals?: "desk" | "terminal" }): Promise<Session> =>
    this.call("PATCH", `/api/desk/sessions/${id}`, patch);
  stop = (id: string): Promise<Session> => this.call("POST", `/api/desk/sessions/${id}/stop`);
  resume = (id: string, prompt?: string): Promise<Session> =>
    this.call("POST", `/api/desk/sessions/${id}/resume`, { prompt });
  forget = (id: string): Promise<void> => this.call("DELETE", `/api/desk/sessions/${id}`);
  decide = (id: string, approval: string, decision: Decision): Promise<Session> =>
    this.desk("POST", `/api/desk/sessions/${id}/approvals/${approval}`, { decision });
  restore = (ids: string[]): Promise<Session[]> => this.call("POST", "/api/desk/restore", { ids });
  dismissRestore = (): Promise<void> => this.call("POST", "/api/desk/restore/dismiss");

  /** Vault paths (never values) on this hub. */
  vaultPaths = async (): Promise<string[]> => (await this.call<{ keys: string[] }>("GET", "/api/vault")).keys;
  saveVault = (path: string, value: string): Promise<void> => this.call("POST", `/api/vault/${path}`, { value });

  /** The local agents themselves, created and configured on the person's behalf. */
  createAgent = (agent: { id: string; name: string; system_prompt: string }): Promise<unknown> =>
    this.call("POST", "/api/agents", agent);
  deleteAgent = (id: string): Promise<unknown> => this.call("DELETE", `/api/agents/${encodeURIComponent(id)}`);
  /** A new name and, for agents Desk made, the instructions that say it. */
  renameAgent = (id: string, name: string, systemPrompt?: string): Promise<unknown> =>
    this.call("PATCH", `/api/agents/${encodeURIComponent(id)}`, systemPrompt === undefined ? { name } : { name, system_prompt: systemPrompt });
  /** What agents on this Mac can think with, connected or not. */
  providers = async (): Promise<Provider[]> =>
    (await this.desk<{ providers: Provider[] }>("GET", "/api/desk/providers")).providers;
  /** Connects a provider with its fields (keys, an address); answers with
   *  it as it now is. */
  connectProvider = (id: string, fields: Record<string, string>): Promise<Provider> =>
    this.desk("POST", `/api/desk/providers/${encodeURIComponent(id)}/connect`, { fields });
  disconnectProvider = (id: string): Promise<void> =>
    this.desk<unknown>("DELETE", `/api/desk/providers/${encodeURIComponent(id)}`).then(() => undefined);

  /** An agent's identity file (SOUL.md, IDENTITY.md, …), as text; one it
   *  doesn't have yet is empty. */
  identityFile = async (id: string, file: string): Promise<string> => {
    try {
      return await this.text(`/api/agents/${encodeURIComponent(id)}/identity/${file}`);
    } catch (e) {
      if (e instanceof HubError && e.status === 404) return "";
      throw e;
    }
  };
  saveIdentityFile = (id: string, file: string, text: string): Promise<void> =>
    this.putText(`/api/agents/${encodeURIComponent(id)}/identity/${file}`, text);
  /** Every saved version of an identity file, newest first. */
  identityRevisions = async (id: string, file: string): Promise<Revision[]> =>
    (await this.call<{ revisions: Revision[] }>("GET", `/api/agents/${encodeURIComponent(id)}/identity/${file}/revisions`)).revisions;
  identityRevision = (id: string, file: string, rev: number): Promise<Revision> =>
    this.call("GET", `/api/agents/${encodeURIComponent(id)}/identity/${file}/revisions/${rev}`);
  /** Puts version `rev` back (as a new version: history is never lost). */
  restoreIdentityRevision = (id: string, file: string, rev: number): Promise<unknown> =>
    this.call("POST", `/api/agents/${encodeURIComponent(id)}/identity/${file}/revisions/${rev}/restore`);

  /** How much an agent remembers of you and has learned, and when your
   *  memories with it were last tidied. */
  memorySummary = (id: string): Promise<MemorySummaryWire> =>
    this.call("GET", `/api/agents/${encodeURIComponent(id)}/memory/summary`);
  /** An agent's own check-ins: on or off, its check-in list, the last run. */
  agentHeartbeat = (id: string): Promise<AgentHeartbeat> => this.call("GET", `/api/agents/${encodeURIComponent(id)}/heartbeat`);

  /** An agent's own `config.toml`, as text. */
  agentConfig = (id: string): Promise<string> => this.text(`/api/agents/${encodeURIComponent(id)}/config`);
  saveAgentConfig = (id: string, toml: string): Promise<void> => this.putText(`/api/agents/${encodeURIComponent(id)}/config`, toml);

  /** The crew at a glance: who needs you, who's working, what's done today,
   *  and the overseer's latest brief. */
  overview = (): Promise<Overview> => this.desk("GET", "/api/desk/overview");
  /** A page of what happened, newest first, from before event `before`. */
  activity = (q: { filter?: ActivityFilter; before?: string; limit?: number } = {}): Promise<ActivityPage> => {
    const params = new URLSearchParams({ limit: String(q.limit ?? 100), filter: q.filter ?? "all" });
    if (q.before) params.set("before", q.before);
    return this.desk("GET", `/api/desk/activity?${params}`);
  };
  /** Which agent oversees the crew, and how much it does on its own. */
  manager = (): Promise<Manager> => this.desk("GET", "/api/desk/manager");
  suggestions = async (): Promise<Suggestion[]> =>
    (await this.desk<{ suggestions: Suggestion[] }>("GET", "/api/desk/suggestions")).suggestions;
  /** Does what the overseer suggested, as you. */
  acceptSuggestion = (id: string): Promise<unknown> => this.desk("POST", `/api/desk/suggestions/${encodeURIComponent(id)}/accept`);
  dismissSuggestion = (id: string): Promise<unknown> => this.desk("POST", `/api/desk/suggestions/${encodeURIComponent(id)}/dismiss`);

  rooms = (): Promise<Room[]> => this.call("GET", "/api/desk/rooms");
  createRoom = (name: string, members: RoomMemberRef[], defaultMember?: string): Promise<Room> =>
    this.call("POST", "/api/desk/rooms", { name, members, defaultMember });
  updateRoom = (
    id: string,
    patch: { name?: string; members?: RoomMemberRef[]; defaultMember?: string | null },
  ): Promise<Room> => this.call("PATCH", `/api/desk/rooms/${id}`, patch);
  deleteRoom = (id: string): Promise<void> => this.call("DELETE", `/api/desk/rooms/${id}`);
  roomMessages = (id: string, thread?: string): Promise<RoomMessage[]> =>
    this.call("GET", `/api/desk/rooms/${id}/messages${thread ? `?thread=${thread}` : ""}`);
  post = (id: string, m: { author: string; content: string; threadId?: string | null; hop?: number }): Promise<RoomMessage> =>
    this.call("POST", `/api/desk/rooms/${id}/messages`, m);
  search = (q: string): Promise<{ roomId: string; message: RoomMessage }[]> =>
    this.call("GET", `/api/desk/rooms/search?q=${encodeURIComponent(q)}`);

  /** Desk's restorable state on this hub (see restore/store.ts); a hub
   *  without a state store answers 404. */
  stateList = async (prefix: string): Promise<StateRow[]> =>
    stateRows(await this.desk<unknown>("GET", `/api/desk/state?prefix=${encodeURIComponent(prefix)}&values=true`));
  statePut = async (key: string, value: unknown): Promise<{ updatedAt: string | null }> => {
    const body = await this.desk<unknown>("PUT", `/api/desk/state/${encodeURIComponent(key)}`, { value });
    return { updatedAt: stateRow(body)?.updatedAt ?? null };
  };
  stateRemove = async (key: string): Promise<void> => {
    try {
      await this.desk<unknown>("DELETE", `/api/desk/state/${encodeURIComponent(key)}`);
    } catch (e) {
      // Already gone is gone; a hub without the store says so another way.
      if (!(e instanceof HubError && e.status === 404 && e.message !== NO_ROUTE)) throw e;
    }
  };

  events(onEvent: (e: DeskEvent) => void, onState: (open: boolean) => void): () => void {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      ws = new WebSocket(wsUrl(this.conn.url, "/api/desk/events", this.conn.token));
      ws.onopen = () => {
        retry = 0;
        onState(true);
      };
      ws.onmessage = (m) => onEvent(JSON.parse(m.data as string) as DeskEvent);
      ws.onclose = () => {
        onState(false);
        if (closed) return;
        timer = setTimeout(open, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }

  ptySocket(id: string): WebSocket {
    const ws = new WebSocket(wsUrl(this.conn.url, `/api/desk/sessions/${id}/pty`, this.conn.token));
    ws.binaryType = "arraybuffer";
    return ws;
  }

  // ── Terminals: login shells the hub hosts for grid panes ─────────────────

  /** Opens a login shell; it runs until closed, whether or not Desk is. */
  openTerminal = (t: NewTerminal): Promise<TerminalInfo> => this.call("POST", "/api/desk/terminals", t);
  terminals = (): Promise<TerminalInfo[]> => this.call("GET", "/api/desk/terminals");
  /** Starts a terminal whose shell ended again, where it was. */
  reopenTerminal = (id: string): Promise<TerminalInfo> => this.call("POST", `/api/desk/terminals/${encodeURIComponent(id)}/reopen`);
  closeTerminal = async (id: string): Promise<void> => {
    try {
      await this.call<unknown>("DELETE", `/api/desk/terminals/${encodeURIComponent(id)}`);
    } catch (e) {
      if (!(e instanceof HubError && e.status === 404)) throw e;
    }
  };

  /** The same protocol as a session's: binary frames both ways, text
   *  frames for control (resize). */
  terminalSocket(id: string): WebSocket {
    const ws = new WebSocket(wsUrl(this.conn.url, `/api/desk/terminals/${encodeURIComponent(id)}/pty`, this.conn.token));
    ws.binaryType = "arraybuffer";
    return ws;
  }
}
