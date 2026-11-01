import type { DeskSocket } from "./transport";

// What every socket Desk keeps open to a hub shares: a ping while it's
// open, a socket that has gone quiet taken for dropped (a half-open
// connection after sleep or a network change can stay "open" for minutes),
// and the back-off its reconnects wait.

export const PING_MS = 30_000;

/** How long a socket may say nothing, pinged, before it's taken for dropped. */
export const SILENT_MS = PING_MS * 1.5;

/** The wait before reconnect attempt `retry` (from 0). */
export const backoff = (retry: number): number => Math.min(30_000, 1000 * 2 ** retry);

/** A socket's `readyState` while it is open. */
export const OPEN = 1;

/** Stops `ws` telling anyone anything, and closes it. */
export const detach = (ws: DeskSocket | null): void => {
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.close();
};

/** Pings `ws` while it's open; `heard` is called for whatever it says. Once
 *  it has said nothing for `SILENT_MS`, it's closed and its close handler
 *  run at once, as if it had dropped. */
export const keepAlive = (ws: DeskSocket): { heard: () => void; stop: () => void } => {
  let last = Date.now();
  const ping = setInterval(() => {
    if (ws.readyState !== OPEN) return;
    if (Date.now() - last <= SILENT_MS) return ws.send(JSON.stringify({ type: "ping" }));
    const dropped = ws.onclose;
    detach(ws);
    dropped?.(new CloseEvent("close"));
  }, PING_MS);
  return { heard: () => (last = Date.now()), stop: () => clearInterval(ping) };
};
