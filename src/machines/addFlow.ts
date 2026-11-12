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
  | {
      at: "address";
      target: string;
      problem: string | null;
      refused?: boolean;
      suggest?: string;
      /** The name it will have; `named` once the person typed one (else it
       *  follows the address). */
      name?: string;
      named?: boolean;
      /** The SSH config entry picked, when one was. */
      picked?: string | null;
    }
  /** Looking at it. */
  | { at: "checking"; target: string; name: string }
  /** A machine this computer has never connected to: its fingerprint. */
  | { at: "trust"; target: string; name: string; fingerprint: string; keyType: string }
  /** Trusting it, then looking again. */
  | { at: "trusting"; target: string; name: string; fingerprint: string }
  /** Its host key isn't the one this computer knows: refused until the
   *  person forgets the old one (a native yes showing both), with the line
   *  that removes it by hand (`forgetKey`, made natively) as a fallback;
   *  `problem` when forgetting it didn't work. */
  | { at: "changed"; target: string; name: string; fingerprint: string; keyType: string; forgetKey?: string; problem?: string }
  /** Forgetting the old key, after the person's native yes. */
  | { at: "forgetting"; target: string; name: string; fingerprint: string; keyType: string; forgetKey?: string }
  /** It doesn't take this computer's key, or the key is locked; `problem`
   *  when signing in with a password or unlocking didn't work. */
  | { at: "key"; target: string; name: string; user: string | null; why: "refused" | "locked"; problem?: string }
  /** Desk's own field is asking for the machine's password (`password`:
   *  Desk then puts its own key there) or the key's passphrase. */
  | { at: "signingIn"; target: string; name: string; user: string | null; why: "refused" | "locked"; with: "password" | "passphrase" }
  /** Added (once `machine` is known) and being set up; `cancelling` once
   *  the person asked to stop. */
  | {
      at: "setup";
      target: string;
      name: string;
      machine: MachineId | null;
      steps: Steps;
      signedIn: { claude: boolean; codex: boolean };
      cancelling?: boolean;
      /** Why Cancel adding didn't stop it (refused, or no answer in time). */
      cancelProblem?: string;
      /** The person cancelled it and it is gone. */
      cancelled?: boolean;
    };

export type FlowEvent =
  | { type: "edit"; target: string }
  /** An SSH config entry picked: its alias is the address. */
  | { type: "pick"; host: string }
  /** The name typed (`typed`), or suggested for the address. */
  | { type: "name"; name: string; typed: boolean }
  /** `taken`: the names other machines have. */
  | { type: "submit"; taken?: readonly string[] }
  /** "Cancel adding", asked of the native side. */
  | { type: "cancelling" }
  /** Cancel adding was refused, or didn't stop it in time: said, and
   *  Cancel adding works again. */
  | { type: "cancelFailed"; message: string }
  /** "Retry" a failed step: set up again from the start. */
  | { type: "retrying" }
  /** "Retry" the engines step of a machine added already. */
  | { type: "retryingEngines" }
  | { type: "probed"; probe: Probe }
  | { type: "trust" }
  | { type: "trusted" }
  /** Try again after putting the key there (or unlocking it). */
  | { type: "retry" }
  /** Sign in with the machine's password, or unlock the key. */
  | { type: "signIn"; with: "password" | "passphrase" }
  /** Desk's field answered: done (look again), closed, or why not. */
  | { type: "keyed" }
  | { type: "signInCancelled" }
  | { type: "signInFailed"; message: string }
  /** Forget the old host key (asked natively), and what came of it. */
  | { type: "forget" }
  | { type: "forgotten" }
  | { type: "forgetCancelled" }
  | { type: "forgetFailed"; message: string }
  | { type: "added"; machine: MachineId }
  | { type: "setup"; event: SetupEvent }
  | { type: "signedIn"; engine: "claude" | "codex" }
  | { type: "failed"; message: string }
  /** Back to the address (Cancel on a fingerprint, Back from the key help). */
  | { type: "back" };

export const START: Flow = { at: "address", target: "", problem: null, name: "", named: false, picked: null };

/** What the native side says when adding is cancelled. */
export const CANCELLED = "Adding it was cancelled.";

const WAITING: Steps = { connect: { state: "waiting" }, install: { state: "waiting" }, engines: { state: "waiting" } };

/** Where adding goes once `probe` has looked. */
const afterProbe = (target: string, given: string, probe: Probe): Flow => {
  const name = given || probe.name || nameFromTarget(target);
  const { hostKey, access } = probe;
  if (hostKey.kind === "changed") return { at: "changed", target, name, fingerprint: hostKey.fingerprint, keyType: hostKey.keyType, ...(probe.forgetKey ? { forgetKey: probe.forgetKey } : {}) };
  if (hostKey.kind === "new") return { at: "trust", target, name, fingerprint: hostKey.fingerprint, keyType: hostKey.keyType };
  if (!access) return { at: "address", target, name, named: true, problem: "Desk couldn’t look at that machine. Try again.", refused: true };
  switch (access.kind) {
    case "refused":
      return { at: "key", target, name, user: access.user, why: "refused" };
    case "locked":
      return { at: "key", target, name, user: null, why: "locked" };
    case "unreachable":
      return { at: "address", target, name, named: true, problem: access.message || `Desk can’t reach ${name}.`, refused: true, ...(access.suggest ? { suggest: access.suggest } : {}) };
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
      return f.at === "address" ? { at: "address", target: e.target, problem: null, name: f.name, named: f.named, picked: null } : f;
    case "pick":
      return f.at === "address" ? { at: "address", target: e.host, problem: null, name: f.name, named: f.named, picked: e.host } : f;
    case "name":
      if (f.at !== "address" || (!e.typed && f.named)) return f;
      return { ...f, name: e.name, named: e.typed || f.named, problem: e.typed ? null : f.problem };
    case "submit": {
      if (f.at !== "address") return f;
      const target = f.target.trim();
      const name = (f.name ?? "").trim() || nameFromTarget(target);
      const problem =
        targetProblem(target) ??
        (name.length > 60 ? "Give it a name of up to 60 letters." : null) ??
        (e.taken?.some((t) => t.toLowerCase() === name.toLowerCase()) ? `Another machine is called ${name} already. Two machines can’t share a name.` : null);
      return problem ? { ...f, problem, refused: false } : { at: "checking", target, name };
    }
    case "probed":
      return f.at === "checking" ? afterProbe(f.target, f.name, e.probe) : f;
    case "trust":
      return f.at === "trust" ? { at: "trusting", target: f.target, name: f.name, fingerprint: f.fingerprint } : f;
    case "trusted":
      return f.at === "trusting" ? { at: "checking", target: f.target, name: f.name } : f;
    case "retry":
      return f.at === "key" ? { at: "checking", target: f.target, name: f.name } : f;
    case "signIn":
      return f.at === "key" ? { at: "signingIn", target: f.target, name: f.name, user: f.user, why: f.why, with: e.with } : f;
    case "keyed":
      return f.at === "signingIn" ? { at: "checking", target: f.target, name: f.name } : f;
    case "signInCancelled":
      return f.at === "signingIn" ? { at: "key", target: f.target, name: f.name, user: f.user, why: f.why } : f;
    case "signInFailed":
      return f.at === "signingIn" ? { at: "key", target: f.target, name: f.name, user: f.user, why: f.why, problem: e.message } : f;
    case "forget":
      return f.at === "changed"
        ? { at: "forgetting", target: f.target, name: f.name, fingerprint: f.fingerprint, keyType: f.keyType, ...(f.forgetKey ? { forgetKey: f.forgetKey } : {}) }
        : f;
    case "forgotten":
      return f.at === "forgetting" ? { at: "checking", target: f.target, name: f.name } : f;
    case "forgetCancelled":
    case "forgetFailed":
      return f.at === "forgetting"
        ? {
            at: "changed",
            target: f.target,
            name: f.name,
            fingerprint: f.fingerprint,
            keyType: f.keyType,
            ...(f.forgetKey ? { forgetKey: f.forgetKey } : {}),
            ...(e.type === "forgetFailed" ? { problem: e.message } : {}),
          }
        : f;
    case "cancelling":
      return f.at === "setup" ? { ...f, cancelling: true, cancelProblem: undefined } : f;
    case "cancelFailed":
      return f.at === "setup" && f.cancelling ? { ...f, cancelling: false, cancelProblem: e.message } : f;
    case "retrying":
      return f.at === "setup" ? { ...f, steps: { ...WAITING, connect: { state: "running" } } } : f;
    case "retryingEngines":
      return f.at === "setup" ? { ...f, steps: { ...f.steps, engines: { state: "running" } } } : f;
    case "added":
      return f.at === "setup" && !f.machine ? { ...f, machine: e.machine } : f;
    case "setup": {
      if (f.at !== "setup" || (f.machine && e.event.machine !== f.machine)) return f;
      const { state, detail, message, line } = e.event;
      if (state === "failed" && message === CANCELLED) return { ...f, cancelled: true };
      const item: Item = { state, ...(detail ? { detail } : {}), ...(message ? { message } : {}), ...(line ? { line } : {}) };
      return { ...f, machine: f.machine ?? e.event.machine, steps: { ...f.steps, [e.event.step]: item } };
    }
    case "signedIn":
      return f.at === "setup" ? { ...f, signedIn: { ...f.signedIn, [e.engine]: true } } : f;
    case "failed":
      // Once added, a step says what failed; before, adding starts again.
      if (f.at === "setup" && f.machine) return f;
      return { at: "address", target: f.target, name: "name" in f ? f.name : undefined, named: true, problem: e.message, refused: true };
    case "back":
      return f.at === "setup" ? f : { at: "address", target: f.target, name: "name" in f ? f.name : undefined, named: true, problem: null };
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
