// Machines: Linux computers of the person's that run Desk's engine, headless,
// reached from this computer over SSH by Desk's native side (src-tauri, PR MS).
// The page knows a machine only by its id: the native side holds its address,
// its tunnel and its tokens, and the page never builds a command line.
//
// The contract with the native side (designs/desk-remote-machines-design.md
// §6.1):
// - `machines_list() -> Machine[]`, and the event `machines-changed` on any
//   change of state;
// - `machine_fetch`: as `local_hub_fetch`, plus the header `x-desk-machine`;
// - `machine_socket_open({ machine, path, events })`: as
//   `local_hub_socket_open`, with the same `socket_send`/`socket_ack`/
//   `socket_close`;
// - `claude_plugin_dir({ machine })`: the machine's plugin folder.
//
// This computer's engine is the machine `local`. Its sessions keep their own ids as
// their keys, as before machines; a machine's are `<machine>/<id>`.

/** Which engine: `local` (this computer) or a machine's id. */
export type MachineId = string;

/** This computer's engine. */
export const LOCAL: MachineId = "local";

/** Where a machine stands, as the native side says. */
export type MachineState =
  | { kind: "adding" }
  | { kind: "connecting" }
  | { kind: "ready" }
  | { kind: "unreachable" }
  | { kind: "updating" }
  | { kind: "newer" }
  | { kind: "failed"; message: string }
  /** Updating it to this Desk's version stopped, or was cancelled: it runs
   *  `from` still, and is driven no further until it matches. */
  | { kind: "updateFailed"; message: string; from: string | null };

/** An update to this Desk's version, step by step, as the native side runs it. */
export interface UpdateRun {
  to: string;
  from: string | null;
  steps: { key: "download" | "copy" | "switch" | "reconnect"; state: "waiting" | "running" | "done" | "failed"; detail?: string }[];
}

/** How Desk reaches a machine, as the person's SSH config makes it. */
export interface Reach {
  user: string | null;
  hostname: string | null;
  port: string | null;
  /** A jump host (`bastion`), or "a ProxyCommand". */
  via: string | null;
  /** The SSH config `Host` entry its address is, and the file it's in. */
  entry: string | null;
  file: string | null;
  /** The line that removes its old key from known_hosts (`ssh-keygen -R
   *  '[10.0.3.14]:2222'`), as the native side makes it. */
  forgetKey?: string | null;
}

/** What Desk's last look there found, besides its system. */
export interface Details {
  freeKb: number | null;
  linger: boolean | null;
  /** Desk's user service is enabled there. */
  service: boolean;
  systemd: boolean;
  user: string | null;
  /** The line that turns linger on there, made (and quoted) natively. */
  lingerLine?: string | null;
}

/** The host key Desk knows a machine by. */
export interface HostKeyInfo {
  /** `ED25519`. */
  kind: string;
  fingerprint: string;
  /** When it was trusted from Desk (ms); none when known_hosts had it. */
  trustedAt: number | null;
}

export interface Machine {
  id: MachineId;
  name: string;
  /** Its SSH address, as the person gave it (`devbox`). */
  target: string;
  /** The Desk version installed there, once known. */
  version: string | null;
  state: MachineState;
  /** Its system, once Desk has looked (`Ubuntu 24.04`, `x86_64`). */
  system?: { os: string; arch: string; glibc?: string | null } | null;
  /** Why it is offline or failed, in Desk's words; and ssh's own line. */
  reason?: string | null;
  said?: string | null;
  /** Times, in ms: last reached, last tried, next try, connected since. */
  lastConnected?: number | null;
  lastTry?: number | null;
  nextTry?: number | null;
  connectedSince?: number | null;
  reach?: Reach | null;
  details?: Details | null;
  hostKey?: HostKeyInfo | null;
  /** The key it shows now, when that isn't the one Desk knows. */
  shownKey?: HostKeyInfo | null;
  /** What an install or update there is doing now. */
  progress?: string | null;
  /** An update to this Desk's version under way, or the one that stopped. */
  update?: UpdateRun | null;
}

const KINDS = new Set(["adding", "connecting", "ready", "unreachable", "updating", "newer", "failed"]);

/** A state as the native side writes it: a word (`"ready"`), or for one that
 *  failed `{ failed: { message } }` or `{ kind | state: "failed", message }`.
 *  Anything else reads as failed, saying so. */
export const readState = (raw: unknown): MachineState => {
  if (typeof raw === "string" && KINDS.has(raw) && raw !== "failed") return { kind: raw } as MachineState;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const failed = o.failed as { message?: unknown } | undefined;
    if (failed && typeof failed === "object") return { kind: "failed", message: String(failed.message ?? "") };
    const update = o.update_failed as { message?: unknown; from?: unknown } | undefined;
    if (update && typeof update === "object")
      return { kind: "updateFailed", message: String(update.message ?? ""), from: typeof update.from === "string" ? update.from : null };
    const kind = typeof o.kind === "string" ? o.kind : typeof o.state === "string" ? o.state : null;
    if (kind === "failed") return { kind: "failed", message: String(o.message ?? "") };
    if (kind && KINDS.has(kind)) return { kind } as MachineState;
  }
  if (raw === "failed") return { kind: "failed", message: "" };
  return { kind: "failed", message: "Desk couldn’t read where this machine stands." };
};

/** A machine's system as listed; null when it isn't known. */
const readSystem = (raw: unknown): Machine["system"] => {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  return o && typeof o.arch === "string"
    ? { os: typeof o.os === "string" ? o.os : "Linux", arch: o.arch, glibc: typeof o.glibc === "string" ? o.glibc : null }
    : null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

/** An update run as listed; null when it isn't one. */
const readUpdate = (raw: unknown): UpdateRun | null => {
  const o = obj(raw);
  if (!o || !Array.isArray(o.steps) || typeof o.to !== "string") return null;
  const KEYS = ["download", "copy", "switch", "reconnect"];
  const STATES = ["waiting", "running", "done", "failed"];
  const steps = o.steps.flatMap((x): UpdateRun["steps"] => {
    const st = obj(x);
    if (!st || typeof st.key !== "string" || !KEYS.includes(st.key) || typeof st.state !== "string" || !STATES.includes(st.state)) return [];
    return [{ key: st.key as UpdateRun["steps"][number]["key"], state: st.state as UpdateRun["steps"][number]["state"], ...(typeof st.detail === "string" ? { detail: st.detail } : {}) }];
  });
  return { to: o.to, from: typeof o.from === "string" ? o.from : null, steps };
};

/** What the native side says beyond its state, read leniently. */
const readMore = (o: Record<string, unknown>): Partial<Machine> => {
  const reach = obj(o.reach);
  const details = obj(o.details);
  const key = obj(o.hostKey);
  const shown = obj(o.shownKey);
  const more: Partial<Machine> = {
    reason: str(o.reason),
    said: str(o.said),
    lastConnected: num(o.lastConnected),
    lastTry: num(o.lastTry),
    nextTry: num(o.nextTry),
    connectedSince: num(o.connectedSince),
    reach: reach
      ? { user: str(reach.user), hostname: str(reach.hostname), port: str(reach.port), via: str(reach.via), entry: str(reach.entry), file: str(reach.file), forgetKey: str(reach.forgetKey) }
      : null,
    details: details
      ? {
          freeKb: num(details.freeKb),
          linger: typeof details.linger === "boolean" ? details.linger : null,
          service: details.service === true,
          systemd: details.systemd === true,
          user: str(details.user),
          lingerLine: str(details.lingerLine),
        }
      : null,
    hostKey: key && str(key.fingerprint) ? { kind: str(key.kind) ?? "", fingerprint: str(key.fingerprint)!, trustedAt: num(key.trustedAt) } : null,
    shownKey: shown && str(shown.fingerprint) ? { kind: str(shown.kind) ?? "", fingerprint: str(shown.fingerprint)!, trustedAt: null } : null,
    progress: str(o.progress),
    update: readUpdate(o.update),
  };
  // Only what it said: a machine listed without them reads as before.
  return Object.fromEntries(Object.entries(more).filter(([, v]) => v !== null)) as Partial<Machine>;
};

/** A machine as `machines_list` lists it; null for a row without an id. */
export const readMachine = (raw: unknown): Machine | null => {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id || o.id === LOCAL || o.id.includes("/")) return null;
  const system = readSystem(o.system);
  return {
    id: o.id,
    name: typeof o.name === "string" && o.name ? o.name : o.id,
    target: typeof o.target === "string" ? o.target : "",
    version: typeof o.version === "string" ? o.version : null,
    state: readState(o.state),
    ...(system ? { system } : {}),
    ...readMore(o),
  };
};

/** Whether the page talks to a machine in state `s`: once it is ready, and
 *  through a drop or an update while it was (its events socket reconnects
 *  itself). One on a newer Desk is driven no further; one being added, or
 *  that failed, has no engine to talk to. */
export const drivable = (s: MachineState, wasOpen: boolean): boolean =>
  s.kind === "ready" || (wasOpen && (s.kind === "unreachable" || s.kind === "updating" || s.kind === "connecting"));

// ── Keys ────────────────────────────────────────────────────────────────

/** The key of session (or terminal) `id` on `machine`: its own id on this
 *  computer, as Desk has always stored it, `<machine>/<id>` on a machine. */
export const keyOf = (machine: MachineId | null | undefined, id: string): string =>
  !machine || machine === LOCAL ? id : `${machine}/${id}`;

/** A key's machine and id on it. */
export const splitKey = (key: string): { machine: MachineId; id: string } => {
  const at = key.indexOf("/");
  return at < 0 ? { machine: LOCAL, id: key } : { machine: key.slice(0, at), id: key.slice(at + 1) };
};

/** Where something stamped with its machine is: `local` when it says none. */
export const machineOf = (x: { machine?: MachineId | null } | null | undefined): MachineId => x?.machine || LOCAL;

/** A session's key. */
export const sessionKey = (s: { id: string; machine?: MachineId | null }): string => keyOf(machineOf(s), s.id);
