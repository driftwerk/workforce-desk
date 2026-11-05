// How Desk speaks of machines: this computer by what it is, a machine by its
// name, and each state in plain words.

import type { Look } from "../floor/background";
import { useHost, type Platform } from "../shell/host";
import { LOCAL, type Machine, type MachineId, type MachineState } from "./engines";

/** This computer, as a heading or a Run on choice. */
export const thisComputer = (p: Platform): string => (p === "macos" ? "This Mac" : "This computer");

/** This computer, mid-sentence. */
export const thisComputerLower = (p: Platform): string => (p === "macos" ? "this Mac" : "this computer");

/** The name of `machine` (this computer's by what it is). */
export const nameOfMachine = (machine: MachineId, machines: readonly Machine[], p: Platform = useHost.getState().platform): string =>
  machine === LOCAL ? thisComputer(p) : (machines.find((m) => m.id === machine)?.name ?? machine);

/** Whether a session can be started on, or sent to, a machine in state `s`. */
export const usable = (s: MachineState): boolean => s.kind === "ready";

/** A machine's status dot, in the theme's state colours: connected (done's
 *  green), can't reach (blocked's amber), updating (working's blue, filled),
 *  failed (red), and the idle ring while it connects or is driven no further. */
export const dotOf = (s: MachineState): Look | "failed" => {
  switch (s.kind) {
    case "ready":
      return "done";
    case "unreachable":
      return "blocked";
    case "updating":
    case "adding":
      return "working";
    case "failed":
      return "failed";
    case "connecting":
    case "newer":
      return "idle";
  }
};

/** Why a machine can't take a session now, after its name in a chip. */
export const offlineWord = (s: MachineState): string | null => {
  switch (s.kind) {
    case "ready":
      return null;
    case "unreachable":
      return "offline";
    case "updating":
      return "updating";
    case "newer":
      return "on a newer Desk";
    case "failed":
      return "not working";
    case "adding":
    case "connecting":
      return "connecting";
  }
};

/** What a machine's row in Settings says of where it stands, besides its
 *  counts; null when it is connected (the row says that with its counts). */
export const stateText = (m: Machine, deskVersion: string | null): string | null => {
  switch (m.state.kind) {
    case "ready":
      return null;
    case "adding":
      return "Being set up…";
    case "connecting":
      return "Connecting…";
    case "unreachable":
      return "Can’t reach it right now. Its sessions keep running; Desk reconnects when it can.";
    case "updating":
      return `Updating Desk${deskVersion ? ` to ${deskVersion}` : ""}… its sessions carry on`;
    case "newer":
      return `It runs a newer Desk${m.version ? ` (${m.version})` : ""}. Update Desk here to drive it; its sessions keep running.`;
    case "failed":
      return m.state.message || "Desk couldn’t set it up.";
  }
};

/** A machine's name from the address it was added by: an SSH config host
 *  as it is, `user@address` as its address. */
export const nameFromTarget = (target: string): string => {
  const at = target.lastIndexOf("@");
  return (at < 0 ? target : target.slice(at + 1)).trim();
};

/** Why `target` can't be an SSH address, or null when it can be. The
 *  native side checks again: this is only to say so before asking it. */
export const targetProblem = (target: string): string | null => {
  const t = target.trim();
  if (!t) return "Type the machine’s address.";
  if (t.startsWith("-")) return "An address can’t start with a dash.";
  // Whitespace and control characters, which no SSH host or user has.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(t)) return "An address has no spaces in it.";
  if (new TextEncoder().encode(t).length > 255) return "That address is too long.";
  return null;
};

/** What Desk says when a session is dragged from one machine's sidebar
 *  to another's: groups don't mix machines. */
export const acrossMachines = (from: string, to: string, fromInSentence: string | null = null): string =>
  `${from}’s sessions stay with ${fromInSentence ?? from}. Groups don’t mix machines, so it can’t move to ${to}.`;
