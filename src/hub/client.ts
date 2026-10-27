import type { Decision, DeskEvent, NewSession, Room, RoomMemberRef, RoomMessage, Session } from "./types";

export interface HubConnection {
  url: string;
  token: string;
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
