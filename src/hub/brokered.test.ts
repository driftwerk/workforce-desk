import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The native side, as the page reaches it: every invoke recorded, and the
// channel a socket's frames arrive on.
const native = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown; options?: { headers?: Record<string, string> } }[],
  answer: (_cmd: string, _args: unknown): unknown => undefined,
  channels: [] as { onmessage: (m: unknown) => void }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
    native.calls.push({ cmd, args, options });
    return native.answer(cmd, args);
  }),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
    constructor() {
      native.channels.push(this);
    }
  },
}));

import { brokered, BridgedSocket } from "./broker";
import { DeskHub, HubError } from "./client";
import { useDesk } from "./store";
import type { Body, DeskSocket, DeskTransport } from "./transport";

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  native.calls.length = 0;
  native.channels.length = 0;
  native.answer = () => undefined;
});
afterEach(() => vi.restoreAllMocks());

/** Every public request `DeskHub` makes, by method: what the native
 *  allowlist (src-tauri/src/broker/routes.rs) is checked against. */
const SAMPLES: Record<string, (h: DeskHub) => unknown> = {
  sessions: (h) => h.sessions(),
  start: (h) => h.start({ engine: "claude", cwd: "/w" } as never),
  spend: (h) => h.spend("week" as never, "engine" as never, 10),
  engines: (h) => h.engines(),
  update: (h) => h.update("s1", { name: "x" }),
  stop: (h) => h.stop("s1"),
  interrupt: (h) => h.interrupt("s1"),
  allowAsked: (h) => h.allowAsked("s1"),
  dismissAsked: (h) => h.dismissAsked("s1"),
  resume: (h) => h.resume("s1", "go on"),
  remove: (h) => h.remove("s1", true),
  end: (h) => h.end("s1"),
  closedSessions: (h) => h.closedSessions(),
  hiddenSessions: (h) => h.hiddenSessions(),
  trackAgain: (h) => h.trackAgain({ engine: "claude", cliSessionId: "a/b c" } as never),
  clearFinished: (h) => h.clearFinished({ olderThanDays: 7 }),
  decide: (h) => h.decide("s1", "ap1", "allow" as never),
  nameSession: (h) => h.nameSession("s 1", "Name"),
  restore: (h) => h.restore(["s1"]),
  dismissRestore: (h) => h.dismissRestore(),
  vaultPaths: (h) => h.vaultPaths(),
  saveVault: (h) => h.saveVault("speech/openai/api_key", "k"),
  createAgent: (h) => h.createAgent({ id: "a", name: "A", system_prompt: "" }),
  deleteAgent: (h) => h.deleteAgent("a b"),
  renameAgent: (h) => h.renameAgent("a", "B", "p"),
  setAgentPicture: (h) => Promise.all([h.setAgentPicture("a", new Blob([new Uint8Array([1, 2])], { type: "image/png" })), h.setAgentPicture("a", null)]),
  providers: (h) => h.providers(),
  connectProvider: (h) => h.connectProvider("anthropic", { key: "k" }),
  disconnectProvider: (h) => h.disconnectProvider("anthropic"),
  identityFile: (h) => h.identityFile("a", "SOUL.md"),
  saveIdentityFile: (h) => h.saveIdentityFile("a", "SOUL.md", "text"),
  identityRevisions: (h) => h.identityRevisions("a", "SOUL.md"),
  identityRevision: (h) => h.identityRevision("a", "SOUL.md", 3),
  restoreIdentityRevision: (h) => h.restoreIdentityRevision("a", "SOUL.md", 3),
  memorySummary: (h) => h.memorySummary("a"),
  agentHeartbeat: (h) => h.agentHeartbeat("a"),
  agentConfig: (h) => h.agentConfig("a"),
  saveAgentConfig: (h) => h.saveAgentConfig("a", "x = 1"),
  overview: (h) => h.overview(),
  activity: (h) => h.activity({ filter: "needs_you" as never, before: "e1", limit: 5 }),
  manager: (h) => h.manager(),
  suggestions: (h) => h.suggestions(),
  acceptSuggestion: (h) => h.acceptSuggestion("g1"),
  dismissSuggestion: (h) => h.dismissSuggestion("g1"),
  rooms: (h) => h.rooms(),
  createRoom: (h) => h.createRoom("R", []),
  updateRoom: (h) => h.updateRoom("r1", { name: "R2" } as never),
  deleteRoom: (h) => h.deleteRoom("r1"),
  roomMessages: (h) => h.roomMessages("r1", { thread: "t", before: "m1", after: "m0", around: "m2", limit: 5 }),
  roomMessage: (h) => h.roomMessage("r1", "m 1"),
  post: (h) => h.post("r1", { text: "hi" } as never),
  copyToRoom: (h) => h.copyToRoom("r1", "m1"),
  unread: (h) => h.unread(),
  reads: (h) => h.reads(),
  putReads: (h) => h.putReads([]),
  markAllRead: (h) => h.markAllRead("everything"),
  search: (h) =>
    h.search({ q: "hello there!", room: "r1", from: "me", has: ["link", "file"], inThread: true, after: "2026-01-01", before: "2026-02-01" } as never, 20),
  stateList: (h) => h.stateList("grid/"),
  statePut: (h) => h.statePut("grid/a b", { x: 1 }),
  stateRemove: (h) => h.stateRemove("grid/a"),
  events: (h) => h.events(() => {}, () => {}),
  ptySocket: (h) => h.ptySocket("s1"),
  layout: (h) => h.layout(),
  importLayout: (h) => h.importLayout({ layout: {} as never, sessionNames: {} }),
  createGroup: (h) => h.createGroup({ id: "g", name: "G" }),
  updateGroup: (h) => h.updateGroup("g", { collapsed: true }),
  deleteGroup: (h) => h.deleteGroup("g"),
  moveGroup: (h) => h.moveGroup("g", null),
  putInGroup: (h) => h.putInGroup("g", "agent:local/desk", null),
  orderUngrouped: (h) => h.orderUngrouped([]),
  openTerminal: (h) => h.openTerminal({ cwd: "/w" } as never),
  terminals: (h) => h.terminals(),
  reopenTerminal: (h) => h.reopenTerminal("t 1"),
  closeTerminal: (h) => h.closeTerminal("t1"),
  terminalSocket: (h) => h.terminalSocket("t 1"),
};

/** The DeskHub members that aren't requests of their own. */
const HELPERS = new Set(["t", "request", "call", "desk", "text", "putText", "constructor"]);

const publicMembers = (h: DeskHub): string[] =>
  [...Object.keys(h), ...Object.getOwnPropertyNames(Object.getPrototypeOf(h))].filter((k) => !HELPERS.has(k)).sort();

interface Recorded {
  kind: "http" | "socket";
  method: string;
  path: string;
}

const recording = (): { transport: DeskTransport; recorded: Recorded[] } => {
  const recorded: Recorded[] = [];
  const quiet: DeskSocket = { readyState: 0, binaryType: "arraybuffer", onopen: null, onmessage: null, onclose: null, onerror: null, send: () => {}, close: () => {} };
  return {
    recorded,
    transport: {
      fetch: async (method: string, path: string, _body?: Body) => {
        recorded.push({ kind: "http", method, path });
        return new Response(JSON.stringify({ keys: [], providers: [], reads: [], revisions: [], suggestions: [], picture: null }), {
          headers: { "content-type": "application/json" },
        });
      },
      socket: (path: string) => {
        recorded.push({ kind: "socket", method: "GET", path });
        return quiet;
      },
    },
  };
};

describe("what DeskHub asks of the local hub", () => {
  it("is every request its methods make, and the native allowlist is checked against the same list", async () => {
    const { transport, recorded } = recording();
    const hub = new DeskHub(transport);
    expect(Object.keys(SAMPLES).sort()).toEqual(publicMembers(hub));
    for (const sample of Object.values(SAMPLES)) {
      const done = sample(hub);
      if (typeof done === "function") (done as () => void)();
      await Promise.resolve(done).catch(() => undefined);
    }
    await expect(`${JSON.stringify(recorded, null, 2)}\n`).toMatchFileSnapshot("./brokered-requests.json");
  });
});

describe("the brokered transport", () => {
  it("sends the method, path and body to the native side, and no token", async () => {
    native.answer = () => ({ status: 200, contentType: "application/json", body: '{"keys":["a"]}' });
    const hub = new DeskHub(brokered);
    expect(await hub.vaultPaths()).toEqual(["a"]);
    await hub.saveAgentConfig("scout", "x = 1");
    await hub.update("s1", { name: "x" });
    const [list, config, update] = native.calls;
    expect(list).toMatchObject({ cmd: "local_hub_fetch", options: { headers: { "x-desk-method": "GET", "x-desk-path": encodeURIComponent("/api/vault") } } });
    expect(list!.args).toEqual(new Uint8Array());
    expect(config!.options!.headers).toEqual({ "x-desk-method": "PUT", "x-desk-path": encodeURIComponent("/api/agents/scout/config"), "x-desk-type": "text%2Fplain" });
    expect(new TextDecoder().decode(config!.args as Uint8Array)).toBe("x = 1");
    expect(new TextDecoder().decode(update!.args as Uint8Array)).toBe('{"name":"x"}');
    const sent = JSON.stringify(native.calls.map((c) => [c.cmd, c.options, Array.from(c.args as Uint8Array)]));
    expect(sent).not.toMatch(/token|bearer|authorization/i);
  });

  it("answers as the hub did: its refusals, an empty answer, a text file", async () => {
    const hub = new DeskHub(brokered);
    native.answer = () => ({ status: 409, contentType: "application/json", body: '{"error":"config.toml changed since it was read"}' });
    const e = await hub.agentConfig("scout").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HubError);
    expect((e as HubError).status).toBe(409);
    expect((e as HubError).message).toBe("config.toml changed since it was read");
    native.answer = () => ({ status: 204, contentType: null, body: "" });
    await expect(hub.dismissRestore()).resolves.toBeUndefined();
    native.answer = () => ({ status: 200, contentType: "text/plain", body: "name = 'x'" });
    expect(await hub.agentConfig("scout")).toBe("name = 'x'");
    native.answer = () => ({ status: 200, contentType: "text/html", body: "<html>" });
    expect(((await hub.rooms().catch((x: unknown) => x)) as HubError).status).toBe(404);
  });

  it("sends an agent's picture as its bytes", async () => {
    native.answer = () => ({ status: 200, contentType: "application/json", body: '{"picture":null}' });
    await new DeskHub(brokered).setAgentPicture("a", new Blob([new Uint8Array([7, 8, 9])], { type: "image/png" }));
    expect(native.calls[0]!.options!.headers!["x-desk-type"]).toBe("image%2Fpng");
    expect(Array.from(native.calls[0]!.args as Uint8Array)).toEqual([7, 8, 9]);
  });

  it("a refusal from the native side reaches the caller", async () => {
    native.answer = () => {
      throw "Desk doesn't send GET /x to this computer's hub.";
    };
    await expect(new DeskHub(brokered).rooms()).rejects.toBe("Desk doesn't send GET /x to this computer's hub.");
  });
});

describe("a bridged socket", () => {
  // What a test was given is acknowledged within it, not in the next.
  afterEach(async () => {
    await settle();
    await settle();
  });

  const opened = async () => {
    native.answer = (cmd) => (cmd === "local_hub_socket_open" ? 7 : undefined);
    const ws = brokered.socket("/api/desk/sessions/s1/pty") as BridgedSocket;
    const heard = { open: 0, messages: [] as unknown[], closes: [] as CloseEvent[], errors: 0 };
    ws.onopen = () => heard.open++;
    ws.onmessage = (m) => heard.messages.push(m.data);
    ws.onclose = (c) => heard.closes.push(c);
    ws.onerror = () => heard.errors++;
    await settle();
    const channel = native.channels[0]!;
    return { ws, heard, say: (m: unknown) => channel.onmessage(m) };
  };

  it("opens through the native side, by path alone", async () => {
    const { ws, heard, say } = await opened();
    expect(native.calls[0]).toMatchObject({ cmd: "local_hub_socket_open", args: { path: "/api/desk/sessions/s1/pty" } });
    expect(Object.keys(native.calls[0]!.args as object).sort()).toEqual(["events", "path"]);
    expect(ws.readyState).toBe(WebSocket.CONNECTING);
    expect(() => ws.send("x")).toThrow();
    say({ type: "open" });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(heard.open).toBe(1);
  });

  it("hears text and binary frames as a WebSocket would", async () => {
    const { heard, say } = await opened();
    say({ type: "open" });
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    say(bytes);
    say({ type: "text", data: '{"type":"viewer"}', n: 17 });
    expect(heard.messages).toEqual([bytes, '{"type":"viewer"}']);
    expect(heard.messages[0]).toBeInstanceOf(ArrayBuffer);
  });

  const acks = () => native.calls.filter((c) => c.cmd === "local_hub_socket_ack").map((c) => c.args);

  it("acknowledges what its handler heard, many frames at once", async () => {
    const { say } = await opened();
    say({ type: "open" });
    say(new Uint8Array(3).buffer);
    say(new Uint8Array(5).buffer);
    say({ type: "text", data: "é", n: 2 });
    expect(acks()).toEqual([]);
    await settle();
    await settle();
    expect(acks()).toEqual([{ id: 7, bytes: 10 }]);
  });

  it("goes on after a handler throws, as a WebSocket does", async () => {
    const { ws, say } = await opened();
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    ws.onopen = () => {
      throw new Error("a bad open");
    };
    say({ type: "open" });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const heard: unknown[] = [];
    ws.onmessage = (m) => {
      heard.push(m.data);
      if (heard.length === 1) throw new Error("a bad frame");
    };
    // The Channel the frames come through stops at a callback that throws.
    expect(() => say(new Uint8Array(4).buffer)).not.toThrow();
    say({ type: "text", data: "next", n: 4 });
    expect(heard).toEqual([new Uint8Array(4).buffer, "next"]);
    await settle();
    await settle();
    expect(acks()).toEqual([{ id: 7, bytes: 8 }]);
    expect(reported).toHaveBeenCalledTimes(2);
  });

  it("holds an acknowledgement until its handler is done with the frame", async () => {
    const { ws, say } = await opened();
    say({ type: "open" });
    const releases: (() => void)[] = [];
    ws.onmessage = () => releases.push(ws.hold());
    say(new Uint8Array(6).buffer);
    say(new Uint8Array(4).buffer);
    await settle();
    expect(acks()).toEqual([]);
    releases[1]!();
    releases[1]!();
    await settle();
    await settle();
    expect(acks()).toEqual([{ id: 7, bytes: 4 }]);
    releases[0]!();
    await settle();
    await settle();
    expect(acks()).toEqual([
      { id: 7, bytes: 4 },
      { id: 7, bytes: 6 },
    ]);
    // Outside a handler there is nothing to hold.
    ws.hold()();
    await settle();
    expect(acks()).toHaveLength(2);
  });

  it("sends frames in the order they were sent, each as its own kind", async () => {
    const { ws, say } = await opened();
    say({ type: "open" });
    // The first send stays with the native side until released.
    let release: () => void = () => {};
    let first = true;
    native.answer = (cmd) => {
      if (cmd !== "local_hub_socket_send" || !first) return undefined;
      first = false;
      return new Promise<void>((r) => (release = r));
    };
    ws.send(new TextEncoder().encode("a"));
    ws.send('{"type":"claim"}');
    ws.send(new Uint8Array([9]).buffer);
    await settle();
    // The first is still with the native side: the rest wait for it.
    expect(native.calls.filter((c) => c.cmd === "local_hub_socket_send")).toHaveLength(1);
    release();
    await settle();
    await settle();
    const sends = native.calls.filter((c) => c.cmd === "local_hub_socket_send");
    expect(sends.map((c) => [c.options!.headers!["x-desk-socket"], c.options!.headers!["x-desk-frame"], Array.from(c.args as Uint8Array)])).toEqual([
      ["7", "binary", [97]],
      ["7", "text", Array.from(new TextEncoder().encode('{"type":"claim"}'))],
      ["7", "binary", [9]],
    ]);
  });

  it("closes after what was sent, and says so once the hub has", async () => {
    const { ws, heard, say } = await opened();
    say({ type: "open" });
    ws.send("last");
    ws.close();
    expect(ws.readyState).toBe(WebSocket.CLOSING);
    await settle();
    await settle();
    expect(native.calls.map((c) => c.cmd)).toEqual(["local_hub_socket_open", "local_hub_socket_send", "local_hub_socket_close"]);
    expect(native.calls[2]!.args).toEqual({ id: 7 });
    say({ type: "close", code: 1000, reason: "", clean: true });
    say({ type: "text", data: "late", n: 4 });
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(heard.closes.map((c) => [c.code, c.wasClean])).toEqual([[1000, true]]);
    expect(heard.messages).toEqual([]);
  });

  it("a socket the native side won't open errors and closes", async () => {
    native.answer = (cmd) => {
      if (cmd === "local_hub_socket_open") throw "Desk doesn't send GET /ws/desk to this computer's hub.";
    };
    const ws = brokered.socket("/ws/desk");
    const closes: CloseEvent[] = [];
    let errors = 0;
    ws.onerror = () => errors++;
    ws.onclose = (c) => closes.push(c);
    await settle();
    expect(errors).toBe(1);
    expect(closes.map((c) => c.code)).toEqual([1006]);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    ws.close();
    await settle();
    expect(native.calls.map((c) => c.cmd)).toEqual(["local_hub_socket_open"]);
  });
});

describe("the desk over the broker", () => {
  afterEach(() => vi.useRealTimers());

  it("connects, loads what the hub has, and reconnects when the hub goes away", async () => {
    vi.useFakeTimers();
    let opened = 0;
    native.answer = (cmd) => (cmd === "local_hub_socket_open" ? ++opened : undefined);
    const stop = useDesk.getState().connect(brokered);
    await vi.advanceTimersByTimeAsync(0);
    expect(native.calls[0]).toMatchObject({ cmd: "local_hub_socket_open", args: { path: "/api/desk/events" } });
    const say = (m: unknown) => native.channels.at(-1)!.onmessage(m);
    say({ type: "open" });
    expect(useDesk.getState().connected).toBe(true);
    const session = { id: "s1", engine: "claude", state: "running", name: "One" };
    const snapshot = JSON.stringify({ type: "snapshot", sessions: [session], restore: [], rooms: [] });
    say({ type: "text", data: snapshot, n: snapshot.length });
    expect(useDesk.getState().loaded).toBe(true);
    expect(Object.keys(useDesk.getState().sessions)).toEqual(["s1"]);
    say({ type: "close", code: 1006, reason: "", clean: false });
    expect(useDesk.getState().connected).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(native.calls.filter((c) => c.cmd === "local_hub_socket_open")).toHaveLength(2);
    say({ type: "open" });
    expect(useDesk.getState().connected).toBe(true);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(native.calls.at(-1)).toMatchObject({ cmd: "local_hub_socket_close", args: { id: 2 } });
    // Nothing the page sent or was given carried a token.
    expect(JSON.stringify(native.calls.map((c) => [c.cmd, c.args, c.options]))).not.toMatch(/token|bearer|authorization/i);
  });
});
