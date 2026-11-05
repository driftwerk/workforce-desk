import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake native side, as the page reaches it (designs/desk-remote-machines-
// design.md §6.1): `local_hub_fetch` and `machine_fetch` answer from each
// engine's own routes, and each socket's frames arrive on the channel it was
// opened with, by the engine it was opened on.
const native = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown; options?: { headers?: Record<string, string> } }[],
  /** Each engine's answer to `METHOD path`, by machine (`local` for this computer). */
  routes: {} as Record<string, Record<string, unknown>>,
  sockets: [] as { cmd: string; machine: string; path: string; events: { onmessage: (m: unknown) => void } }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
    native.calls.push({ cmd, args, options });
    if (cmd === "local_hub_fetch" || cmd === "machine_fetch") {
      const h = options?.headers ?? {};
      const machine = cmd === "machine_fetch" ? decodeURIComponent(h["x-desk-machine"]!) : "local";
      const route = `${decodeURIComponent(h["x-desk-method"]!)} ${decodeURIComponent(h["x-desk-path"]!)}`;
      const body = native.routes[machine]?.[route];
      return body === undefined
        ? { status: 404, contentType: "application/json", body: '{"error":"no such route"}' }
        : { status: 200, contentType: "application/json", body: JSON.stringify(body) };
    }
    if (cmd === "local_hub_socket_open" || cmd === "machine_socket_open") {
      const a = args as { machine?: string; path: string; events: { onmessage: (m: unknown) => void } };
      native.sockets.push({ cmd, machine: a.machine ?? "local", path: a.path, events: a.events });
      return native.sockets.length;
    }
    return undefined;
  }),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

import { brokered, machineTransport } from "./broker";
import { watchMachines, type MachineSide } from "./engines";
import { drivable, keyOf, readMachine, readState, sessionKey, splitKey } from "./machines";
import { deskListeners, engineListeners, hubFor, hubOf, localSessions, useDesk, type EngineEvent } from "./store";
import type { DeskEvent, Room, Session } from "./types";
import { sessionActions } from "../session/actions";

const settle = () => new Promise((r) => setTimeout(r, 0));

const session = (id: string, name: string, more: Partial<Session> = {}): Session =>
  ({
    id,
    name,
    engine: "claude",
    goal: "",
    cwd: "/work",
    state: "working",
    live: true,
    origin: "desk",
    pending: null,
    updatedAt: "2026-11-05T10:00:00Z",
    createdAt: "2026-11-05T09:00:00Z",
    ...more,
  }) as Session;

const room = (id: string): Room => ({ id, name: id, slug: id }) as Room;

/** Engine `machine`'s events socket says `e`. */
const say = (machine: string, e: DeskEvent) => {
  const s = native.sockets.filter((x) => x.machine === machine && x.path === "/api/desk/events").at(-1)!;
  s.events.onmessage({ type: "text", data: JSON.stringify(e), n: 1 });
};
const open = (machine: string) => native.sockets.filter((x) => x.machine === machine).forEach((s) => s.events.onmessage({ type: "open" }));

const snapshot = (sessions: Session[], more: Partial<Extract<DeskEvent, { type: "snapshot" }>> = {}): DeskEvent => ({
  type: "snapshot",
  sessions,
  restore: [],
  rooms: [],
  ...more,
});

let stops: (() => void)[] = [];

beforeEach(() => {
  native.calls.length = 0;
  native.sockets.length = 0;
  native.routes = {};
  useDesk.setState({ hub: null, connected: false, engines: {}, sessions: {}, rooms: {}, restore: [], openId: null, loaded: false });
});
afterEach(() => {
  stops.forEach((s) => s());
  stops = [];
});

/** This computer's engine and devbox's, connected as the app connects them. */
const both = () => {
  stops.push(useDesk.getState().connect(brokered));
  stops.push(useDesk.getState().connectMachine("devbox", machineTransport("devbox")));
  open("local");
  open("devbox");
};

describe("keys", () => {
  it("keep this computer's sessions by their own ids, and a machine's under its id", () => {
    expect(keyOf("local", "s1")).toBe("s1");
    expect(keyOf(undefined, "s1")).toBe("s1");
    expect(keyOf("devbox", "s1")).toBe("devbox/s1");
    expect(splitKey("s1")).toEqual({ machine: "local", id: "s1" });
    expect(splitKey("devbox/s1")).toEqual({ machine: "devbox", id: "s1" });
    expect(sessionKey(session("s1", "a"))).toBe("s1");
    expect(sessionKey({ ...session("s1", "a"), machine: "devbox" })).toBe("devbox/s1");
  });

  it("read a machine as the native side lists it, its state in any of its shapes", () => {
    expect(readMachine({ id: "devbox", name: "devbox", target: "dev@box", version: "0.4.0", state: "ready" })).toEqual({
      id: "devbox",
      name: "devbox",
      target: "dev@box",
      version: "0.4.0",
      state: { kind: "ready" },
    });
    expect(readState({ failed: { message: "no glibc" } })).toEqual({ kind: "failed", message: "no glibc" });
    expect(readState({ kind: "failed", message: "x" })).toEqual({ kind: "failed", message: "x" });
    expect(readState({ state: "newer" })).toEqual({ kind: "newer" });
    expect(readState("sideways").kind).toBe("failed");
    // This computer's id, or one a key can't hold, is no machine's.
    expect(readMachine({ id: "local", state: "ready" })).toBeNull();
    expect(readMachine({ id: "a/b", state: "ready" })).toBeNull();
  });

  it("drive a machine once ready, through a drop or an update, and never one on a newer Desk", () => {
    expect(drivable({ kind: "ready" }, false)).toBe(true);
    expect(drivable({ kind: "connecting" }, false)).toBe(false);
    expect(drivable({ kind: "unreachable" }, true)).toBe(true);
    expect(drivable({ kind: "updating" }, true)).toBe(true);
    expect(drivable({ kind: "newer" }, true)).toBe(false);
    expect(drivable({ kind: "failed", message: "" }, true)).toBe(false);
  });
});

describe("several engines", () => {
  it("reach a machine by its id through machine_fetch, and this computer as before", async () => {
    native.routes = { local: { "GET /api/desk/engines": [] }, devbox: { "GET /api/desk/engines": [{ engine: "codex" }] } };
    both();
    await hubOf("local")!.engines();
    await hubOf("devbox")!.engines();
    const fetches = native.calls.filter((c) => c.cmd.endsWith("_fetch"));
    expect(fetches.map((c) => c.cmd)).toEqual(["local_hub_fetch", "machine_fetch"]);
    expect(fetches[0]!.options!.headers).toEqual({ "x-desk-method": "GET", "x-desk-path": encodeURIComponent("/api/desk/engines") });
    expect(fetches[1]!.options!.headers).toEqual({
      "x-desk-method": "GET",
      "x-desk-path": encodeURIComponent("/api/desk/engines"),
      "x-desk-machine": "devbox",
    });
    // Each engine's events socket, by machine id.
    expect(native.sockets.map((s) => [s.cmd, s.machine, s.path])).toEqual([
      ["local_hub_socket_open", "local", "/api/desk/events"],
      ["machine_socket_open", "devbox", "/api/desk/events"],
    ]);
    expect(native.calls.find((c) => c.cmd === "machine_socket_open")!.args).toMatchObject({ machine: "devbox", path: "/api/desk/events" });
    const sent = JSON.stringify(native.calls.map((c) => [c.cmd, c.options]));
    expect(sent).not.toMatch(/token|bearer|authorization/i);
  });

  it("key the same session id on two engines apart, each stamped with its machine", () => {
    both();
    say("local", snapshot([session("s1", "api-e7")]));
    say("devbox", snapshot([session("s1", "web-d2")]));
    const { sessions, engines, hub, connected } = useDesk.getState();
    expect(Object.keys(sessions).sort()).toEqual(["devbox/s1", "s1"]);
    expect(sessions.s1!.machine).toBeUndefined();
    expect(sessions["devbox/s1"]).toMatchObject({ id: "s1", name: "web-d2", machine: "devbox" });
    expect(engines.devbox).toMatchObject({ connected: true, loaded: true });
    // This computer's engine is `hub`, as it always was.
    expect(engines.local!.hub).toBe(hub);
    expect(connected).toBe(true);
    expect(Object.keys(localSessions(sessions))).toEqual(["s1"]);
  });

  it("let a machine's snapshot replace only its own sessions, and tell this computer's listeners nothing", () => {
    both();
    const mine = vi.fn();
    const all = vi.fn();
    const heardAll = (e: EngineEvent) => all(e.machine ?? "local", e.type);
    deskListeners.add(mine);
    engineListeners.add(heardAll);
    try {
      say("local", snapshot([session("s1", "api-e7")], { rooms: [room("general")] }));
      say("devbox", snapshot([session("s1", "web-d2"), session("s2", "worker")], { rooms: [room("theirs")], restore: [session("r1", "old")] }));
      say("devbox", { type: "state", key: "grid.index", value: { order: ["theirs"] } });
      say("devbox", { type: "layout", layout: { groups: [], ungrouped: { order: [], collapsed: false } } as never });
      expect(Object.keys(useDesk.getState().sessions).sort()).toEqual(["devbox/s1", "devbox/s2", "s1"]);
      // Its rooms and restore list aren't this computer's.
      expect(Object.keys(useDesk.getState().rooms)).toEqual(["general"]);
      expect(useDesk.getState().restore).toEqual([]);
      expect(mine.mock.calls.map(([e]) => (e as DeskEvent).type)).toEqual(["snapshot"]);
      expect(all.mock.calls).toEqual([
        ["local", "snapshot"],
        ["devbox", "snapshot"],
        ["devbox", "state"],
        ["devbox", "layout"],
      ]);
      // A session gone from the machine; then this computer's snapshot keeps the machine's.
      say("devbox", { type: "removed", id: "s2" });
      say("local", snapshot([session("s3", "new")]));
      expect(Object.keys(useDesk.getState().sessions).sort()).toEqual(["devbox/s1", "s3"]);
      // A machine's snapshot without one gone leaves this computer's be.
      say("devbox", snapshot([]));
      expect(Object.keys(useDesk.getState().sessions)).toEqual(["s3"]);
    } finally {
      deskListeners.delete(mine);
      engineListeners.delete(heardAll);
    }
  });

  it("route a session's actions to the engine it runs on", async () => {
    native.routes = {
      local: { "POST /api/desk/sessions/s1/stop": session("s1", "api-e7", { state: "stopped" }) },
      devbox: { "POST /api/desk/sessions/s1/stop": session("s1", "web-d2", { state: "stopped" }) },
    };
    both();
    say("local", snapshot([session("s1", "api-e7")]));
    say("devbox", snapshot([session("s1", "web-d2")]));
    const theirs = useDesk.getState().sessions["devbox/s1"]!;
    expect(hubFor(theirs)).toBe(hubOf("devbox"));
    expect(hubFor(useDesk.getState().sessions.s1!)).toBe(useDesk.getState().hub);
    native.calls.length = 0;
    sessionActions(theirs)
      .find((a) => a.label === "Stop")!
      .run();
    await settle();
    sessionActions(useDesk.getState().sessions.s1!)
      .find((a) => a.label === "Stop")!
      .run();
    await settle();
    expect(native.calls.filter((c) => c.cmd.endsWith("_fetch")).map((c) => [c.cmd, c.options?.headers?.["x-desk-machine"] ?? null, decodeURIComponent(c.options!.headers!["x-desk-path"]!)])).toEqual([
      ["machine_fetch", "devbox", "/api/desk/sessions/s1/stop"],
      ["local_hub_fetch", null, "/api/desk/sessions/s1/stop"],
    ]);
  });

  it("let a machine go with its sessions, and the one open beside the Floor", () => {
    stops.push(useDesk.getState().connect(brokered));
    const stop = useDesk.getState().connectMachine("devbox", machineTransport("devbox"));
    open("local");
    open("devbox");
    say("local", snapshot([session("s1", "api-e7")]));
    say("devbox", snapshot([session("s1", "web-d2")]));
    useDesk.getState().open("devbox/s1");
    stop();
    expect(Object.keys(useDesk.getState().sessions)).toEqual(["s1"]);
    expect(useDesk.getState().engines.devbox).toBeUndefined();
    expect(useDesk.getState().openId).toBeNull();
    expect(hubOf("devbox")).toBeNull();
  });
});

describe("the machines kept connected", () => {
  const side = (rows: unknown[]) => {
    let changed: () => void = () => {};
    const s: MachineSide & { rows: unknown[]; change: () => Promise<void> } = {
      rows,
      list: vi.fn(async () => s.rows),
      changed: (f) => {
        changed = f;
        return () => {};
      },
      transport: machineTransport,
      change: async () => {
        changed();
        await settle();
      },
    };
    return s;
  };

  it("open each ready machine, keep one that drops, and let go one on a newer Desk or removed", async () => {
    const s = side([
      { id: "devbox", name: "devbox", target: "devbox", version: "0.4.0", state: "ready" },
      { id: "spare", name: "spare", target: "spare", version: null, state: "adding" },
    ]);
    const onChange = vi.fn();
    stops.push(watchMachines(s, onChange));
    await settle();
    expect(Object.keys(useDesk.getState().engines)).toEqual(["devbox"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    open("devbox");
    say("devbox", snapshot([session("s1", "web-d2")]));
    // It said what it has: the accounts (its boss's) are read again.
    expect(onChange).toHaveBeenCalledTimes(2);
    s.rows = [{ id: "devbox", name: "devbox", target: "devbox", version: "0.4.0", state: "unreachable" }];
    await s.change();
    expect(useDesk.getState().sessions["devbox/s1"]).toBeTruthy();
    s.rows = [{ id: "devbox", name: "devbox", target: "devbox", version: "0.5.0", state: "newer" }];
    await s.change();
    expect(useDesk.getState().engines.devbox).toBeUndefined();
    expect(useDesk.getState().sessions).toEqual({});
    s.rows = [{ id: "devbox", name: "devbox", target: "devbox", version: "0.4.0", state: "ready" }];
    await s.change();
    expect(useDesk.getState().engines.devbox).toBeTruthy();
    s.rows = [];
    await s.change();
    expect(useDesk.getState().engines).toEqual({});
  });

  it("go on without machines when the native side has none to list", async () => {
    const s = side([]);
    s.list = vi.fn(() => Promise.reject(new Error("machines_list isn't a command")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stops.push(watchMachines(s));
    await settle();
    expect(useDesk.getState().engines).toEqual({});
    warn.mockRestore();
  });
});
