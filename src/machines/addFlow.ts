// Adding a machine, as a state machine the card follows: the address; a new
// machine's fingerprint to trust; help putting this computer's key there
// when it's refused; then the setup checklist, and signing in there.
// Pure: the card (AddMachine.tsx) makes the native calls each state asks
// for and feeds back what they said.

import type { MachineId } from "./engines";
import type { Probe, SetupEvent, SetupStep } from "./native";
import { nameFromTarget, targetProblem } from "./words";

export interface Item {
  state: "waiting" | "running" | "done" | "failed" | "blocked";
  /** What it did, or is doing. */
  detail?: string;
  /** Why it failed or waits. */
  message?: string;
  /** What to run there, while it waits on the person. */
  line?: string;
}

export type Steps = Record<SetupStep, Item>;

export type Flow =
  /** Typing the address; `problem` from the last try, `refused` when it
   *  was the machine's (unreachable, or an account Desk won't use) rather
   *  than the address's; `suggest` is another spelling of it that the SSH
   *  config knows. */
  | { at: "address"; target: string; problem: string | null; refused?: boolean; suggest?: string }
  /** Looking at it. */
  | { at: "checking"; target: string }
  /** A machine this computer has never connected to: its fingerprint. */
  | { at: "trust"; target: string; name: string; fingerprint: string; keyType: string }
  /** Trusting it, then looking again. */
  | { at: "trusting"; target: string; fingerprint: string }
  /** Its host key isn't the one this computer knows: refused. */
  | { at: "changed"; target: string; name: string; fingerprint: string; keyType: string }
  /** It doesn't take this computer's key, or the key is locked. */
  | { at: "key"; target: string; name: string; user: string | null; why: "refused" | "locked" }
  /** Added (once `machine` is known) and being set up. */
  | { at: "setup"; target: string; name: string; machine: MachineId | null; steps: Steps; signedIn: { claude: boolean; codex: boolean } };

export type FlowEvent =
  | { type: "edit"; target: string }
  | { type: "submit" }
  | { type: "probed"; probe: Probe }
  | { type: "trust" }
  | { type: "trusted" }
  /** Try again after putting the key there (or unlocking it). */
  | { type: "retry" }
  | { type: "added"; machine: MachineId }
  | { type: "setup"; event: SetupEvent }
  | { type: "signedIn"; engine: "claude" | "codex" }
  | { type: "failed"; message: string }
  /** Back to the address (Cancel on a fingerprint, Back from the key help). */
  | { type: "back" };

export const START: Flow = { at: "address", target: "", problem: null };

const WAITING: Steps = { connect: { state: "waiting" }, install: { state: "waiting" }, engines: { state: "waiting" } };

/** Where adding goes once `probe` has looked. */
const afterProbe = (target: string, probe: Probe): Flow => {
  const name = probe.name || nameFromTarget(target);
  const { hostKey, access } = probe;
  if (hostKey.kind === "changed") return { at: "changed", target, name, fingerprint: hostKey.fingerprint, keyType: hostKey.keyType };
  if (hostKey.kind === "new") return { at: "trust", target, name, fingerprint: hostKey.fingerprint, keyType: hostKey.keyType };
  if (!access) return { at: "address", target, problem: "Desk couldn’t look at that machine. Try again.", refused: true };
  switch (access.kind) {
    case "refused":
      return { at: "key", target, name, user: access.user, why: "refused" };
    case "locked":
      return { at: "key", target, name, user: null, why: "locked" };
    case "unreachable":
      return { at: "address", target, problem: access.message || `Desk can’t reach ${name}.`, refused: true, ...(access.suggest ? { suggest: access.suggest } : {}) };
    case "ok": {
      const sys = access.system ? ` · ${access.system.os} · ${access.system.arch}` : "";
      return {
        at: "setup",
        target,
        name,
        machine: null,
        steps: { ...WAITING, connect: { state: "done", detail: `Connected as ${access.user}${sys}` } },
        signedIn: { claude: false, codex: false },
      };
    }
  }
};

export const step = (f: Flow, e: FlowEvent): Flow => {
  switch (e.type) {
    case "edit":
      return f.at === "address" ? { at: "address", target: e.target, problem: null } : f;
    case "submit": {
      if (f.at !== "address") return f;
      const target = f.target.trim();
      const problem = targetProblem(target);
      return problem ? { ...f, problem } : { at: "checking", target };
    }
    case "probed":
      return f.at === "checking" ? afterProbe(f.target, e.probe) : f;
    case "trust":
      return f.at === "trust" ? { at: "trusting", target: f.target, fingerprint: f.fingerprint } : f;
    case "trusted":
      return f.at === "trusting" ? { at: "checking", target: f.target } : f;
    case "retry":
      return f.at === "key" ? { at: "checking", target: f.target } : f;
    case "added":
      return f.at === "setup" && !f.machine ? { ...f, machine: e.machine } : f;
    case "setup": {
      if (f.at !== "setup" || (f.machine && e.event.machine !== f.machine)) return f;
      const { state, detail, message, line } = e.event;
      const item: Item = { state, ...(detail ? { detail } : {}), ...(message ? { message } : {}), ...(line ? { line } : {}) };
      return { ...f, machine: f.machine ?? e.event.machine, steps: { ...f.steps, [e.event.step]: item } };
    }
    case "signedIn":
      return f.at === "setup" ? { ...f, signedIn: { ...f.signedIn, [e.engine]: true } } : f;
    case "failed":
      // Once added, a step says what failed; before, adding starts again.
      if (f.at === "setup" && f.machine) return f;
      return { at: "address", target: f.target, problem: e.message, refused: true };
    case "back":
      return f.at === "setup" ? f : { at: "address", target: f.target, problem: null };
  }
};

/** The setup is through: Desk is installed there and its engines are. */
export const setUp = (f: Flow): boolean =>
  // Waiting on the person to turn linger on still leaves Desk installed,
  // starting itself each time it connects: set up enough to sign in.
  f.at === "setup" && (f.steps.install.state === "done" || f.steps.install.state === "blocked") && f.steps.engines.state === "done";

/** A step failed: the card says why, and adding goes no further. */
export const setupFailed = (f: Flow): Item | null =>
  f.at === "setup" ? (Object.values(f.steps).find((s) => s.state === "failed") ?? null) : null;
