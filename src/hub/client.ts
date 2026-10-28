import { preview } from "../preview";
import type { Provider } from "./providers";
import type { Decision, DeskEvent, NewSession, Room, RoomMemberRef, RoomMessage, Session } from "./types";

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

export class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const wsUrl = (base: string, path: string, token: string): string => {
  const u = new URL(path, base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("token", token);
  return u.toString();
};

export class DeskHub {
  constructor(private readonly conn: HubConnection) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, this.conn.url), {
      method,
      headers: {
        authorization: `Bearer ${this.conn.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text || res.statusText;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message;
      } catch {
        /* plain-text error body */
      }
      throw new HubError(res.status, message);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
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
    const res = await fetch(new URL(path, this.conn.url), { headers: { authorization: `Bearer ${this.conn.token}` } });
    if (!res.ok) throw new HubError(res.status, (await res.text()) || res.statusText);
    return res.text();
  }

  private async putText(path: string, text: string): Promise<void> {
    const res = await fetch(new URL(path, this.conn.url), {
      method: "PUT",
      headers: { authorization: `Bearer ${this.conn.token}`, "content-type": "text/plain" },
      body: text,
    });
    if (!res.ok) throw new HubError(res.status, (await res.text()) || res.statusText);
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
    this.call("POST", `/api/desk/sessions/${id}/approvals/${approval}`, { decision });
  restore = (ids: string[]): Promise<Session[]> => this.call("POST", "/api/desk/restore", { ids });
  dismissRestore = (): Promise<void> => this.call("POST", "/api/desk/restore/dismiss");

  /** Vault paths (never values) on this hub. */
  vaultPaths = async (): Promise<string[]> => (await this.call<{ keys: string[] }>("GET", "/api/vault")).keys;
  saveVault = (path: string, value: string): Promise<void> => this.call("POST", `/api/vault/${path}`, { value });

  /** The local agents themselves, created and configured on the person's behalf. */
  createAgent = (agent: { id: string; name: string; system_prompt: string }): Promise<unknown> =>
    this.call("POST", "/api/agents", agent);
  deleteAgent = (id: string): Promise<unknown> => this.call("DELETE", `/api/agents/${encodeURIComponent(id)}`);
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

  /** An agent's own `config.toml`, as text. */
  agentConfig = (id: string): Promise<string> => this.text(`/api/agents/${encodeURIComponent(id)}/config`);
  saveAgentConfig = (id: string, toml: string): Promise<void> => this.putText(`/api/agents/${encodeURIComponent(id)}/config`, toml);

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
}
