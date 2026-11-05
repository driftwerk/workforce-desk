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
  | { kind: "failed"; message: string };

export interface Machine {
  id: MachineId;
  name: string;
  /** Its SSH address, as the person gave it (`devbox`). */
  target: string;
  /** The Desk version installed there, once known. */
  version: string | null;
  state: MachineState;
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
    const kind = typeof o.kind === "string" ? o.kind : typeof o.state === "string" ? o.state : null;
    if (kind === "failed") return { kind: "failed", message: String(o.message ?? "") };
    if (kind && KINDS.has(kind)) return { kind } as MachineState;
  }
  if (raw === "failed") return { kind: "failed", message: "" };
  return { kind: "failed", message: "Desk couldn’t read where this machine stands." };
};

/** A machine as `machines_list` lists it; null for a row without an id. */
export const readMachine = (raw: unknown): Machine | null => {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id || o.id === LOCAL || o.id.includes("/")) return null;
  return {
    id: o.id,
    name: typeof o.name === "string" && o.name ? o.name : o.id,
    target: typeof o.target === "string" ? o.target : "",
    version: typeof o.version === "string" ? o.version : null,
    state: readState(o.state),
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
