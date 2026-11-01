// How the page reaches a hub: requests and sockets.
//
// In the app that is through Desk's native side, which holds every token:
// `brokered` (./broker.ts) for the local hub's admin surface, `pairedHub`
// (./net.ts) for every paired hub by id. In the browser preview, which has
// no native side, and in tests, it is `direct`, with a token of its own.

import type { HubConnection } from "./client";

/** A request's body: its bytes or text, and what they are. */
export interface Body {
  type: string;
  data: string | Blob;
}

/** What `DeskHub` uses of a WebSocket. */
export interface DeskSocket {
  readonly readyState: number;
  binaryType: BinaryType;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void;
  close(): void;
  /** A brokered socket's: called from `onmessage`, the frame being heard
   *  counts as taken only once the returned function is called. */
  hold?(): () => void;
}

export interface DeskTransport {
  /** `method path` (`path` with its query) to the hub, answered as fetch answers. */
  fetch(method: string, path: string, body?: Body): Promise<Response>;
  /** One of the hub's sockets, frames as ArrayBuffers. */
  socket(path: string): DeskSocket;
}

const wsUrl = (base: string, path: string, token: string): string => {
  const u = new URL(path, base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("token", token);
  return u.toString();
};

/** Straight to the hub at `conn`, with its token: the browser preview,
 *  and tests. Never in the app, where the page holds no token. */
export const direct = (conn: HubConnection): DeskTransport => ({
  fetch: (method, path, body) =>
    globalThis.fetch(new URL(path, conn.url), {
      method,
      headers: { authorization: `Bearer ${conn.token}`, ...(body ? { "content-type": body.type } : {}) },
      body: body?.data,
    }),
  socket: (path) => {
    const ws = new WebSocket(wsUrl(conn.url, path, conn.token));
    ws.binaryType = "arraybuffer";
    return ws;
  },
});
