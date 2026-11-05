// Every native command the machines' UI calls, in one place: the transport,
// the list and the plugin folder are MD4's and MS's (hub/broker.ts,
// platform.ts); adding, trusting and the rest are MD3's. The native side
// holds each machine's address, tunnel and tokens, runs the fixed SSH
// scripts and asks its own native confirm; the page names a
// machine by id, or, while adding one, by the address the person typed,
// which the native side validates again. Nothing typed here runs as a
// command line.
//
// Tests pass a fake `MachineNative`; the app uses `native`.

import { machineTransport } from "../hub/broker";
import type { DeskTransport } from "../hub/transport";
import { invoke, listen, machinePluginDir, machinesList, onMachinesChanged, subscribe } from "../platform";
import { readMachine, type Machine, type MachineId } from "./engines";

/** What the machine's SSH host key is to this computer. */
export type HostKey =
  | { kind: "known" }
  /** Never seen: the person is shown its fingerprint and trusts it, or not. */
  | { kind: "new"; fingerprint: string; keyType: string }
  /** Not the one this computer knows: refused, never trusted from Desk. */
  | { kind: "changed"; fingerprint: string; keyType: string };

/** Whether this computer's SSH key gets in, once the host key is known. */
export type Access =
  | { kind: "ok"; user: string; system: { os: string; arch: string } | null }
  /** The machine doesn't take any of this computer's keys. */
  | { kind: "refused"; user: string | null }
  /** The key needs a passphrase no agent holds (`ssh-add`). */
  | { kind: "locked" }
  /** Couldn't connect at all (no route, no such host, timed out). `suggest`:
   *  when the name didn't resolve, another spelling of it that the SSH
   *  config knows ("Did you mean devbox?"). */
  | { kind: "unreachable"; message: string; suggest?: string };

/** What a first look at an address found. */
export interface Probe {
  /** The address as the native side reads it (its SSH config resolved). */
  target: string;
  /** The machine's name, as its SSH config or address gives it. */
  name: string;
  hostKey: HostKey;
  /** Null while the host key isn't known: nothing is sent before then. */
  access: Access | null;
}

/** One step of setting a machine up, after it's been added. */
export type SetupStep = "connect" | "install" | "engines";

export interface SetupEvent {
  machine: MachineId;
  step: SetupStep;
  state: "running" | "done" | "failed" | "blocked";
  /** What it did ("Connected as dev · Ubuntu 24.04 · x86_64"). */
  detail?: string;
  /** Why it failed or waits. */
  message?: string;
  /** A line for the person to run there, while it waits on them (`sudo loginctl enable-linger dev`). */
  line?: string;
}

/** The native side, as the machines' UI uses it. */
export interface MachineNative {
  list(): Promise<Machine[]>;
  /** Calls `f` on any machine's change; the returned function stops it. */
  changed(f: () => void): () => void;
  /** Looks at `target`: its host key, then whether this computer's key gets in. */
  probe(target: string): Promise<Probe>;
  /** Adds the host key with `fingerprint` to this computer's known hosts,
   *  after the native confirm; refused when the machine now shows another. */
  trust(target: string, fingerprint: string): Promise<void>;
  /** This computer's public SSH key, to put in the machine's
   *  `~/.ssh/authorized_keys`; null when it has none. */
  publicKey(): Promise<string | null>;
  /** Adds the machine and sets it up there (§4), reporting each step on
   *  `setup`; its id. */
  add(target: string, name: string): Promise<MachineId>;
  setup(f: (e: SetupEvent) => void): () => void;
  remove(id: MachineId): Promise<void>;
  /** "Try again": connects now rather than at the next back-off. */
  reconnect(id: MachineId): Promise<void>;
  /** Signs the machine's Claude Code in with this computer's account. */
  shareSignIn(id: MachineId, engine: "claude"): Promise<void>;
  /** Desk's Claude Code plugin folder on the machine (`<bin>/current/claude-plugin`). */
  pluginDir(id: MachineId): Promise<string | null>;
  /** The machine's engine's admin surface, through its own broker. */
  transport(id: MachineId): DeskTransport;
}

export const native: MachineNative = {
  list: async () => ((await machinesList()) ?? []).flatMap((r) => readMachine(r) ?? []),
  changed: (f) => subscribe(onMachinesChanged(f)),
  probe: (target) => invoke<Probe>("machine_probe", { target }),
  trust: (target, fingerprint) => invoke<void>("machine_trust", { target, fingerprint }),
  publicKey: () => invoke<string | null>("machine_public_key"),
  add: (target, name) => invoke<MachineId>("machine_add", { target, name }),
  setup: (f) => subscribe(listen<SetupEvent>("machine-setup", (e) => f(e.payload))),
  remove: (id) => invoke<void>("machine_remove", { id }),
  reconnect: (id) => invoke<void>("machine_reconnect", { id }),
  shareSignIn: (id, engine) => invoke<void>("machine_share_sign_in", { id, engine }),
  pluginDir: (id) => machinePluginDir(id),
  transport: machineTransport,
};
