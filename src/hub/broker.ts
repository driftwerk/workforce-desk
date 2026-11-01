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

/** Runs a socket's handler. A handler that throws is reported, as a
 *  WebSocket's would be, and the socket goes on: the frames arrive through
 *  a Channel that would hold every later one back if its callback threw. */
const safely = (handler: () => void): void => {
  try {
    handler();
  } catch (e) {
    console.error("A handler of the local hub's connection failed:", e);
  }
};

/** What the native side says of a socket; `n` is a text frame's size as
 *  the native side counts it. */
type Said =
  | { type: "open" }
  | { type: "text"; data: string; n: number }
  | { type: "error" }
  | { type: "close"; code: number; reason: string; clean: boolean };

/** A socket the native side holds open to the local hub, shaped like the
 *  WebSocket the page would otherwise open: frames arrive in order, and
 *  the page's go one after another.
 *
 *  The native side gives a socket's frames only as fast as the page takes
 *  them: each is acknowledged once its handler has run (or, if the handler
 *  called `hold()`, once it releases it), a few at a time. A terminal
 *  flooding output then waits on the hub rather than filling the page. */
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
  /** Taken and not yet acknowledged; an acknowledgement is on its way. */
  private owed = 0;
  private acking = false;
  /** The frame being heard, until its handler holds it. */
  private hearing: { n: number; held: boolean } | null = null;

  constructor(path: string) {
    const events = new Channel<Said | ArrayBuffer>();
    events.onmessage = (m) => this.heard(m);
    this.id = invoke<number>("local_hub_socket_open", { path, events }).catch((e: unknown) => {
      safely(() => this.onerror?.(new Event("error")));
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

  /** Called from `onmessage`, holds back the acknowledgement of the frame
   *  being heard until the returned function is called (once its data is
   *  used: xterm's write callback). */
  hold(): () => void {
    const frame = this.hearing;
    if (!frame || frame.held) return () => {};
    frame.held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.took(frame.n);
    };
  }

  private took(n: number): void {
    this.owed += n;
    if (this.acking) return;
    this.acking = true;
    // Once the page has had a turn: many frames, one acknowledgement.
    setTimeout(() => {
      this.acking = false;
      const bytes = this.owed;
      this.owed = 0;
      if (bytes > 0 && this.readyState !== BridgedSocket.CLOSED)
        void this.id
          .then((id) => (id === null ? undefined : invoke("local_hub_socket_ack", { id, bytes })))
          .catch((e: unknown) => console.warn("the local hub's connection:", e));
    }, 0);
  }

  private deliver(data: string | ArrayBuffer, n: number): void {
    const frame = { n, held: false };
    this.hearing = frame;
    safely(() => this.onmessage?.(new MessageEvent("message", { data })));
    this.hearing = null;
    if (!frame.held) this.took(n);
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
      this.deliver(m, m.byteLength);
      return;
    }
    switch (m.type) {
      case "open":
        if (this.readyState !== BridgedSocket.CONNECTING) return;
        this.readyState = BridgedSocket.OPEN;
        safely(() => this.onopen?.(new Event("open")));
        return;
      case "text":
        this.deliver(m.data, m.n);
        return;
      case "error":
        safely(() => this.onerror?.(new Event("error")));
        return;
      case "close":
        this.ended(m.code, m.reason, m.clean);
    }
  }

  private ended(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === BridgedSocket.CLOSED) return;
    this.readyState = BridgedSocket.CLOSED;
    safely(() => this.onclose?.(new CloseEvent("close", { code, reason, wasClean })));
  }
}

/** The local hub, in the app. */
export const brokered: DeskTransport = {
  fetch: fetchVia,
  socket: (path) => new BridgedSocket(path),
};
