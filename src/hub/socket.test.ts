import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../testing/sockets";
import { backoff, keepAlive, PING_MS } from "./socket";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const opened = async () => {
  const ws = new FakeSocket("ws://hub.test/ws");
  await Promise.resolve();
  const dropped = vi.fn();
  ws.onclose = dropped;
  return { ws, dropped, alive: keepAlive(ws as unknown as WebSocket) };
};

describe("a socket kept open to a hub", () => {
  it("is pinged while the hub answers", async () => {
    const { ws, dropped, alive } = await opened();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(PING_MS);
      alive.heard();
    }
    expect(ws.sent.filter((m) => m.type === "ping")).toHaveLength(4);
    expect(dropped).not.toHaveBeenCalled();
    alive.stop();
  });

  it("is taken for dropped once it has said nothing for a ping and a half, its handlers let go", async () => {
    const { ws, dropped } = await opened();
    vi.advanceTimersByTime(PING_MS);
    expect(dropped).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PING_MS);
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(ws.readyState).toBe(FakeSocket.CLOSING);
    expect(ws.onclose).toBeNull();
    vi.advanceTimersByTime(PING_MS * 3);
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it("waits longer before each reconnect, up to 30 seconds", () => {
    expect([0, 1, 2, 5, 9].map(backoff)).toEqual([1000, 2000, 4000, 30_000, 30_000]);
  });
});
