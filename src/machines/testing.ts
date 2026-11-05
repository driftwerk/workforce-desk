// A fake native side for the machines' tests: every call recorded, each
// answered as the test sets, and setup events sent when the test says.

import { vi } from "vitest";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DeskTransport } from "../hub/transport";
import type { Machine } from "./engines";
import type { MachineNative, Probe, SetupEvent } from "./native";

export const machine = (m: Partial<Machine> & Pick<Machine, "id">): Machine => ({
  name: m.id,
  target: m.id,
  version: "0.2.0",
  state: { kind: "ready" },
  system: { os: "Ubuntu 24.04", arch: "x86_64" },
  ...m,
});

export const probeOf = (p: Partial<Probe> = {}): Probe => ({
  target: "devbox",
  name: "devbox",
  hostKey: { kind: "known" },
  access: { kind: "ok", user: "dev", system: { os: "Ubuntu 24.04", arch: "x86_64" } },
  ...p,
});

/** A transport answering `GET /api/desk/folders` with `folders`. */
export const foldersTransport = (folders: unknown, seen: string[] = []): DeskTransport => ({
  fetch: async (_method, path) => {
    seen.push(path);
    return path.startsWith("/api/desk/folders") ? Response.json(folders) : new Response(null, { status: 404 });
  },
  socket: () => {
    throw new Error("no sockets here");
  },
});

export function fakeNative(over: Partial<MachineNative> = {}) {
  const heard = new Set<(e: SetupEvent) => void>();
  const changed = new Set<() => void>();
  const fake = {
    list: vi.fn(async () => [] as Machine[]),
    changed: vi.fn((f: () => void) => {
      changed.add(f);
      return () => changed.delete(f);
    }),
    probe: vi.fn(async (_target: string) => probeOf()),
    trust: vi.fn(async (_target: string, _fingerprint: string) => undefined),
    publicKey: vi.fn(async () => "ssh-ed25519 AAAAC3NzaExampleKey you@laptop" as string | null),
    add: vi.fn(async (_target: string, _name: string) => "devbox"),
    setup: vi.fn((f: (e: SetupEvent) => void) => {
      heard.add(f);
      return () => heard.delete(f);
    }),
    remove: vi.fn(async (_id: string) => undefined),
    reconnect: vi.fn(async (_id: string) => undefined),
    shareSignIn: vi.fn(async (_id: string, _engine: "claude") => undefined),
    signInForward: vi.fn(async (_id: string, _signIn: string) => "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A46009%2Fcallback" as string),
    signInForwardStop: vi.fn(async (_id: string) => undefined),
    pluginDir: vi.fn(async (_id: string) => "/home/dev/.local/share/Desk/bin/current/claude-plugin" as string | null),
    transport: vi.fn((_id: string) => foldersTransport([])),
  };
  Object.assign(fake, over);
  /** Sends a setup event, as the native side would. */
  const emit = (e: SetupEvent) => heard.forEach((f) => f(e));
  const change = () => changed.forEach((f) => f());
  return { native: fake as MachineNative, fake, emit, change };
}

/** The page talking to `machine`'s engine `hub`, as MD4's `connectMachine` leaves it. */
export const withEngine = (machine: string, hub: DeskHub): void =>
  useDesk.setState((s) => ({ engines: { ...s.engines, [machine]: { hub, connected: true, loaded: true, error: null } } }));

/** No machine's engine. */
export const noEngines = (): void =>
  useDesk.setState((s) => ({ engines: Object.fromEntries(Object.entries(s.engines).filter(([id]) => id === "local")) }));
