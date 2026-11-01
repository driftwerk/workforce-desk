// The local hub's admin surface through Desk's native side
// (src-tauri/src/broker), which holds the hub's gateway token: the page asks
// for a request by method and path, and never has a token to put in it.

import { Channel, invoke } from "@tauri-apps/api/core";
import type { Body, DeskSocket, DeskTransport } from "./transport";

interface Answer {
  status: number;
  contentType: string | null;
  body: string;
}

/** Statuses whose answer has no body (a Response refuses one). */
const EMPTY = new Set([101, 204, 205, 304]);

const bytesOf = async (body: Body | undefined): Promise<Uint8Array> => {
  if (!body) return new Uint8Array();
  if (typeof body.data === "string") return new TextEncoder().encode(body.data);
  return new Uint8Array(await body.data.arrayBuffer());
};

const fetchVia = async (method: string, path: string, body?: Body): Promise<Response> => {
  const headers: Record<string, string> = {
    "x-desk-method": encodeURIComponent(method),
    "x-desk-path": encodeURIComponent(path),
  };
  if (body) headers["x-desk-type"] = encodeURIComponent(body.type);
  const a = await invoke<Answer>("local_hub_fetch", await bytesOf(body), { headers });
  return new Response(EMPTY.has(a.status) ? null : a.body, {
    status: a.status,
    headers: a.contentType ? { "content-type": a.contentType } : {},
  });
};

/** What the native side says of a socket. */
type Said = { type: "open" } | { type: "text"; data: string } | { type: "error" } | { type: "close"; code: number; reason: string; clean: boolean };

/** A socket the native side holds open to the local hub, shaped like the
 *  WebSocket the page would otherwise open: frames arrive in order, and
 *  the page's go one after another. */
export class BridgedSocket implements DeskSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = BridgedSocket.CONNECTING;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private readonly id: Promise<number | null>;
  /** Sends (and the close) in the order the page made them. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    const events = new Channel<Said | ArrayBuffer>();
    events.onmessage = (m) => this.heard(m);
    this.id = invoke<number>("local_hub_socket_open", { path, events }).catch((e: unknown) => {
      this.onerror?.(new Event("error"));
      this.ended(1006, String(e), false);
      return null;
    });
  }

  send(data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
    if (this.readyState !== BridgedSocket.OPEN) throw new DOMException("The connection isn't open.", "InvalidStateError");
    const text = typeof data === "string";
    const bytes = text
      ? new TextEncoder().encode(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
        : new Uint8Array(data).slice();
    this.then((id) =>
      invoke("local_hub_socket_send", bytes, { headers: { "x-desk-socket": String(id), "x-desk-frame": text ? "text" : "binary" } }),
    );
  }

  close(): void {
    if (this.readyState === BridgedSocket.CLOSING || this.readyState === BridgedSocket.CLOSED) return;
    this.readyState = BridgedSocket.CLOSING;
    this.then((id) => invoke("local_hub_socket_close", { id }));
  }

  private then(f: (id: number) => Promise<unknown>): void {
    this.queue = this.queue
      .then(() => this.id)
      .then((id) => (id === null ? undefined : f(id)))
      .catch((e: unknown) => console.warn("the local hub's connection:", e));
  }

  private heard(m: Said | ArrayBuffer): void {
    if (this.readyState === BridgedSocket.CLOSED) return;
    if (m instanceof ArrayBuffer) {
      this.onmessage?.(new MessageEvent("message", { data: m }));
      return;
    }
    switch (m.type) {
      case "open":
        if (this.readyState !== BridgedSocket.CONNECTING) return;
        this.readyState = BridgedSocket.OPEN;
        this.onopen?.(new Event("open"));
        return;
      case "text":
        this.onmessage?.(new MessageEvent("message", { data: m.data }));
        return;
      case "error":
        this.onerror?.(new Event("error"));
        return;
      case "close":
        this.ended(m.code, m.reason, m.clean);
    }
  }

  private ended(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === BridgedSocket.CLOSED) return;
    this.readyState = BridgedSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean }));
  }
}

/** The local hub, in the app. */
export const brokered: DeskTransport = {
  fetch: fetchVia,
  socket: (path) => new BridgedSocket(path),
};
