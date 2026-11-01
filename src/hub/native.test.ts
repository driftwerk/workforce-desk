import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The app: the page reaches every paired hub through the native side, by id.
const native = vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  return {
    calls: [] as { cmd: string; args: unknown; options?: { headers?: Record<string, string> } }[],
    answer: (_cmd: string, _args: unknown): unknown => undefined,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
    native.calls.push({ cmd, args, options });
    return native.answer(cmd, args);
  }),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
  convertFileSrc: (p: string) => p,
}));

import { Conversation } from "../chat/conversation";
import type { HubAccount } from "../chat/types";
import { HubLink } from "../hubs/link";
import { jsonBody, pairedHub } from "./net";

const hub: HubAccount = { id: "dw-example-com", label: "Driftwerk", url: "https://dw.example.com", local: false, revision: "r1" };

/** The native side's answer to `hub_fetch`, framed as it frames it. */
const framed = (meta: { status: number; contentType: string | null }, body: Uint8Array): ArrayBuffer => {
  const head = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + head.length + body.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(body, 4 + head.length);
  return out.buffer;
};

const fetchSpy = vi.spyOn(globalThis, "fetch");
const sockets: string[] = [];

beforeEach(() => {
  native.calls.length = 0;
  native.answer = () => undefined;
  fetchSpy.mockClear();
  sockets.length = 0;
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor(url: string) {
        sockets.push(url);
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("a paired hub, in the app", () => {
  it("is asked through the native side by id, with no token and no address from the page", async () => {
    native.answer = () => framed({ status: 200, contentType: "image/png" }, new Uint8Array([137, 80, 78, 71]));
    const res = await pairedHub(hub).fetch("GET", "/api/agents/a%20b/picture?v=2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    const [call] = native.calls;
    expect(call!.cmd).toBe("hub_fetch");
    expect(call!.options!.headers).toEqual({
      "x-desk-hub": "dw-example-com",
      "x-desk-method": "GET",
      "x-desk-path": encodeURIComponent("/api/agents/a%20b/picture?v=2"),
    });
    expect(JSON.stringify(call)).not.toMatch(/authorization|dw\.example\.com/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends a body as bytes with its kind, and reads an empty answer", async () => {
    native.answer = () => framed({ status: 204, contentType: null }, new Uint8Array());
    const res = await pairedHub(hub).fetch("PUT", "/api/desk/conversations/a/read", jsonBody({ at: "x" }));
    expect(res.status).toBe(204);
    const [call] = native.calls;
    expect(call!.options!.headers!["x-desk-type"]).toBe("application%2Fjson");
    expect(new TextDecoder().decode(call!.args as Uint8Array)).toBe('{"at":"x"}');
  });

  it("opens a conversation's socket through the native side, its path naming no token", () => {
    native.answer = (cmd) => (cmd === "hub_socket_open" ? 3 : undefined);
    const c = new Conversation(hub, "scout", () => {});
    const open = native.calls.find((x) => x.cmd === "hub_socket_open")!;
    const args = open.args as { hub: string; path: string };
    expect(args.hub).toBe("dw-example-com");
    const url = new URL(args.path, "wss://hub.invalid");
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.searchParams.get("agent_id")).toBe("scout");
    expect(Object.keys(args).sort()).toEqual(["events", "hub", "path"]);
    expect(sockets).toEqual([]);
    c.close();
  });

  it("opens a hub's link through the native side, its path naming no token", () => {
    native.answer = (cmd) => (cmd === "hub_socket_open" ? 4 : undefined);
    const link = new HubLink(hub, { hello() {}, delivered() {}, changed() {}, closed() {}, unavailable() {} });
    const open = native.calls.find((x) => x.cmd === "hub_socket_open")!;
    expect(open.args).toMatchObject({ hub: "dw-example-com", path: "/ws/desk" });
    expect(sockets).toEqual([]);
    link.close();
  });
});
