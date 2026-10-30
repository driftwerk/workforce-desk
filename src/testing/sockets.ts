// A stand-in for the WebSocket a conversation or hub link opens, for
// tests: it opens at once, keeps what was sent, and is told what the hub
// says. Closed, it says so a moment later, as a browser's does.

export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static opened: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }

  get query(): URLSearchParams {
    return new URL(this.url).searchParams;
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  /** The hub says `msg`. */
  receive(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** The connection drops (or is refused before it opens). */
  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  close() {
    if (this.readyState >= FakeSocket.CLOSING) return;
    this.readyState = FakeSocket.CLOSING;
    setTimeout(() => this.drop(), 0);
  }

  /** Chat frames sent, without pings. */
  get chats(): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type === "chat");
  }

  static reset() {
    FakeSocket.opened = [];
  }

  /** The socket open on `path` for `agent` on `channel`. */
  static find(path: string, agent?: string, channel?: string): FakeSocket | undefined {
    return [...FakeSocket.opened]
      .reverse()
      .find(
        (s) =>
          new URL(s.url).pathname === path &&
          (agent === undefined || s.query.get("agent_id") === agent) &&
          (channel === undefined || s.query.get("channel") === channel) &&
          s.readyState < FakeSocket.CLOSING,
      );
  }
}
