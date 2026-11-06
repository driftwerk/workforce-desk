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

/** What copying this computer's accounts to a machine did: names only,
 *  never a sign-in. */
export interface Shared {
  /** The person said no to the native question: nothing was copied. */
  cancelled: boolean;
  copied: string[];
  /** On the machine already, by name: left as they are. */
  already: string[];
  failed: { name: string; why: string }[];
  /** The machine moves sessions to another account at a limit by itself. */
  autoSwitch: boolean;
}

/** One line of this computer's log of a machine. */
export interface LogLine {
  /** ms */
  at: number;
  kind: "info" | "ok" | "warn" | "error";
  text: string;
}

/** A `Host` entry in the person's SSH config, as its text says. */
export interface HostEntry {
  host: string;
  hostname: string | null;
  user: string | null;
  port: string | null;
  /** A jump host, or "a ProxyCommand". */
  jump: string | null;
  /** The file it's in (`~/.ssh/config`). */
  file: string;
}

/** What changing how a machine is reached did. */
export type Edited =
  | { kind: "done" }
  /** The person said no to the native question: nothing changed. */
  | { kind: "cancelled" }
  /** The new address shows another machine's key: refused. */
  | { kind: "differentKey"; shown: { kind: string; fingerprint: string }; known: { kind: string; fingerprint: string } };

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
  /** "Use this computer's accounts": copies this computer's Claude accounts the
   *  machine hasn't got there, after the native question naming them. The
   *  sign-ins go from this computer's hub to the machine's over SSH, in the
   *  native side alone; the page never sees one. */
  shareAccounts(id: MachineId): Promise<Shared>;
  /** For machine `id`'s Claude sign-in `signIn`: listens on the one port
   *  its page comes back to, on this computer's loopback, carrying it to the
   *  machine's, for as long as the sign-in runs, and opens that page. The
   *  native side reads the page from the machine's hub itself and checks
   *  it: the page never names the port or the page. */
  signInForward(id: MachineId, signIn: string): Promise<void>;
  /** Ends sign-in `signIn`'s listener on machine `id`, or its start. */
  signInForwardStop(id: MachineId, signIn: string): Promise<void>;
  /** Opens a page a machine's engine gave for signing in, once the native
   *  side has checked it is that engine's own (https, its hosts). */
  openSignInPage(engine: "claude" | "codex", url: string): Promise<void>;
  /** Desk's Claude Code plugin folder on the machine (`<bin>/current/claude-plugin`). */
  pluginDir(id: MachineId): Promise<string | null>;
  /** The machine's engine's admin surface, through its own broker. */
  transport(id: MachineId): DeskTransport;
  /** This computer's log of the machine: connecting, ssh's words, when next. */
  log(id: MachineId): Promise<LogLine[]>;
  /** Desk's own log on the machine (its service's last 200 lines), read
   *  over SSH; refused after 10 s. */
  remoteLog(id: MachineId): Promise<string>;
  /** The `Host` entries in the person's SSH config, read as text. */
  sshHosts(): Promise<HostEntry[]>;
  /** A new name, a new address (only once the person says yes natively
   *  and it shows the machine's own host key), or both. */
  edit(id: MachineId, change: { target?: string; name?: string }): Promise<Edited>;
  /** Shows Desk's log on this computer in Finder. */
  revealLog(): Promise<void>;
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
  shareAccounts: (id) => invoke<Shared>("machine_share_accounts", { id }),
  signInForward: (id, signIn) => invoke<void>("machine_sign_in_forward", { machine: id, signIn }),
  signInForwardStop: (id, signIn) => invoke<void>("machine_sign_in_forward_stop", { machine: id, signIn }),
  openSignInPage: (engine, url) => invoke<void>("machine_open_sign_in_page", { engine, url }),
  pluginDir: (id) => machinePluginDir(id),
  transport: machineTransport,
  log: (id) => invoke<LogLine[]>("machine_log", { id }),
  remoteLog: (id) => invoke<string>("machine_remote_log", { id }),
  sshHosts: () => invoke<HostEntry[]>("machine_ssh_hosts"),
  edit: (id, change) => invoke<Edited>("machine_edit", { id, target: change.target ?? null, name: change.name ?? null }),
  revealLog: () => invoke<void>("machine_reveal_log"),
};
