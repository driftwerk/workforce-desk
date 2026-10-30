import type { Layout } from "../groups/model";
import { preview } from "../preview";
import type { Provider } from "./providers";
import type {
  ActivityFilter,
  ActivityPage,
  Decision,
  DeskEvent,
  Manager,
  NewRoomMessage,
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
import { agentPicturePath, pictureOf, type Picture } from "../pictures/pictures";

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

/** What the hub did with Desk's groups and names on the first push. */
export interface LayoutImport {
  /** False when it already had its own, which it kept. */
  imported: boolean;
  layout: Layout;
  sessionNames: Record<string, string>;
}

/** An item key in a route (`agent:local/desk`), its `/` kept. */
const itemPath = (item: string): string => item.split("/").map(encodeURIComponent).join("/");

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
export const refusal = async (res: Response): Promise<HubError> => {
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

/** Chooses `image` as the picture at `path` on a hub (null: chooses none,
 *  so its Slack picture, if any, shows again); the picture shown after. */
export const sendPicture = async (conn: HubConnection, path: string, image: Blob | null): Promise<Picture | null> => {
  const res = await hubFetch(new URL(path, conn.url), {
    method: image ? "PUT" : "DELETE",
    headers: { authorization: `Bearer ${conn.token}`, ...(image ? { "content-type": image.type || "application/octet-stream" } : {}) },
    body: image ?? undefined,
  });
  if (!res.ok) throw await refusal(res);
  if (!(res.headers.get("content-type") ?? "").includes("json")) throw new HubError(404, NO_ROUTE);
  return pictureOf(((await res.json()) as { picture?: unknown }).picture);
};

const wsUrl = (base: string, path: string, token: string): string => {
  const u = new URL(path, base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("token", token);
  return u.toString();
};

/** One call to a hub's API, as `conn`: its status and JSON answer (none
 *  for a 204), and a `HubError` for a refusal or a route the hub doesn't
 *  have. */
export const hubRequest = async <T>(
  conn: HubConnection,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> => {
  const res = await hubFetch(new URL(path, conn.url), {
    method,
    headers: {
      authorization: `Bearer ${conn.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await refusal(res);
  if (res.status === 204) return { status: res.status, body: undefined as T };
  // A hub without this route answers with its web page, not a 404.
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    throw new HubError(404, NO_ROUTE);
  }
  return { status: res.status, body: (await res.json()) as T };
};

/** One call to a hub's API, as `conn`: its JSON answer, nothing for a 204. */
export const hubCall = async <T>(conn: HubConnection, method: string, path: string, body?: unknown): Promise<T> =>
  (await hubRequest<T>(conn, method, path, body)).body;

/** A Desk route; in the browser preview, the dev bridge answers the ones
 *  the running hub doesn't have yet. */
export const deskCall = async <T>(conn: HubConnection, method: string, path: string, body?: unknown): Promise<T> => {
  try {
    return await hubCall<T>(conn, method, path, body);
  } catch (e) {
    if (!preview || !(e instanceof HubError) || e.status !== 404) throw e;
    const { devHub } = await import("../devBridge");
    return devHub<T>(method, path, body);
  }
};

/** The most messages one read of a room or thread returns. */
export const ROOM_PAGE = 100;

export class DeskHub {
  constructor(private readonly conn: HubConnection) {}

  private request = <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> =>
    hubRequest<T>(this.conn, method, path, body);

  private call = <T>(method: string, path: string, body?: unknown): Promise<T> => hubCall<T>(this.conn, method, path, body);

  private desk = <T>(method: string, path: string, body?: unknown): Promise<T> => deskCall<T>(this.conn, method, path, body);

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
  /** Esc in its terminal: ends the turn it is working on, and nothing else. */
  interrupt = (id: string): Promise<Session> => this.call("POST", `/api/desk/sessions/${id}/interrupt`);
  /** Allows the tool auto mode refused for the rest of the session, and
   *  tells it to carry on. */
  allowAsked = (id: string): Promise<Session> => this.call("POST", `/api/desk/sessions/${id}/asked/allow`);
  /** Leaves what it asked unanswered: it is done. */
  dismissAsked = (id: string): Promise<Session> => this.call("POST", `/api/desk/sessions/${id}/asked/dismiss`);
  resume = (id: string, prompt?: string): Promise<Session> =>
    this.call("POST", `/api/desk/sessions/${id}/resume`, { prompt });
  forget = (id: string): Promise<void> => this.call("DELETE", `/api/desk/sessions/${id}`);
  decide = (id: string, approval: string, decision: Decision): Promise<Session> =>
    this.desk("POST", `/api/desk/sessions/${id}/approvals/${approval}`, { decision });
  /** The person's own name for a session (null or blank: none, so the
   *  hub's shows). */
  nameSession = (id: string, name: string | null): Promise<Session> =>
    this.call("PUT", `/api/desk/sessions/${encodeURIComponent(id)}/name`, { name });
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
  /** Chooses a picture for an agent here (null: none); the one it shows after. */
  setAgentPicture = (id: string, image: Blob | null): Promise<Picture | null> => sendPicture(this.conn, agentPicturePath(id), image);
  /** What agents on this computer can think with, connected or not. */
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
  /** A room's newest messages (of one thread, when named), at most a page. */
  roomMessages = (id: string, thread?: string): Promise<RoomMessage[]> =>
    this.call("GET", `/api/desk/rooms/${id}/messages?${new URLSearchParams({ limit: String(ROOM_PAGE), ...(thread ? { thread } : {}) })}`);
  /** Keeps a message in a room; `created` is false when one with its
   *  source was kept already (a hub that keeps no sources keeps it anew). */
  post = async (id: string, m: NewRoomMessage): Promise<{ message: RoomMessage; created: boolean }> => {
    const { status, body } = await this.request<RoomMessage>("POST", `/api/desk/rooms/${id}/messages`, m);
    return { message: body, created: status === 201 || (!!m.source && !body.source) };
  };
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

  // ── The sidebar's groups, kept by the hub ───────────────────────────────
  // Every route answers with the whole layout as it now is.

  layout = (): Promise<Layout> => this.call("GET", "/api/desk/layout");
  /** Desk's first push of the groups and names it kept itself; a hub that
   *  already has some keeps its own (unless `force`). */
  importLayout = (i: { layout: Layout; sessionNames: Record<string, string>; force?: boolean }): Promise<LayoutImport> =>
    this.call("POST", "/api/desk/layout/import", i);
  createGroup = (g: { id: string; name: string; items?: string[]; before?: string | null }): Promise<Layout> =>
    this.call("POST", "/api/desk/groups", g);
  /** Renames a group, or opens or closes it (Ungrouped too, by `ungrouped`). */
  updateGroup = (id: string, patch: { name?: string; collapsed?: boolean }): Promise<Layout> =>
    this.call("PATCH", `/api/desk/groups/${encodeURIComponent(id)}`, patch);
  deleteGroup = (id: string): Promise<Layout> => this.call("DELETE", `/api/desk/groups/${encodeURIComponent(id)}`);
  moveGroup = (id: string, before: string | null): Promise<Layout> =>
    this.call("POST", `/api/desk/groups/${encodeURIComponent(id)}/move`, { before });
  /** Puts an item in a group (or `ungrouped`) before another, out of
   *  wherever it was. */
  putInGroup = (group: string, item: string, before: string | null): Promise<Layout> =>
    this.call("PUT", `/api/desk/groups/${encodeURIComponent(group)}/items/${itemPath(item)}`, { before });
  /** Sets Ungrouped's order to `items` as Desk shows it (only Desk knows
   *  what shows there unlisted), taking each out of whichever group held it. */
  orderUngrouped = (items: string[]): Promise<Layout> =>
    this.call("PUT", "/api/desk/groups/ungrouped/order", { items });

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
   *  frames for control (see session/Terminal.tsx). */
  terminalSocket(id: string): WebSocket {
    const ws = new WebSocket(wsUrl(this.conn.url, `/api/desk/terminals/${encodeURIComponent(id)}/pty`, this.conn.token));
    ws.binaryType = "arraybuffer";
    return ws;
  }
}
