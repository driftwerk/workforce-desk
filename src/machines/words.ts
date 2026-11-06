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

/** A time of day as a row says it: "08:55" today, "5 Nov 08:55" before. */
export const clock = (at: number, now: number = Date.now()): string => {
  const d = new Date(at);
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${hm}`;
};

/** A log line's time, to the second: "09:41:27", or "5 Nov 09:41:27". */
export const clockSeconds = (at: number, now: number = Date.now()): string => {
  const d = new Date(at);
  const hms = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? hms : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${hms}`;
};

/** When it was last reached, as a sentence says it: "today at 08:55",
 *  "yesterday at 08:55", "5 Nov at 08:55". */
export const whenText = (at: number, now: number = Date.now()): string => {
  const d = new Date(at);
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = new Date(now);
  if (day.toDateString() === d.toDateString()) return `today at ${hm}`;
  day.setDate(day.getDate() - 1);
  if (day.toDateString() === d.toDateString()) return `yesterday at ${hm}`;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} at ${hm}`;
};

/** The account a machine is reached as: `root` from `root@devbox`, else its SSH config's. */
export const accountOf = (m: Machine): string | null => (m.target.includes("@") ? m.target.slice(0, m.target.lastIndexOf("@")) : (m.reach?.user ?? null));

/** Another machine in Desk that is the same computer (the same host key,
 *  or the same address and port) reached as another account: "same machine
 *  as devbox, as root". Said of the one listed after it, not of both. */
export const twinNote = (m: Machine, all: readonly Machine[]): string | null => {
  const same = (o: Machine) =>
    o.id !== m.id &&
    ((!!m.hostKey && o.hostKey?.fingerprint === m.hostKey.fingerprint) || (!!m.reach?.hostname && o.reach?.hostname === m.reach.hostname && (o.reach?.port ?? "22") === (m.reach.port ?? "22")));
  const before = all.findIndex((o) => o.id === m.id);
  const twin = all.slice(0, before < 0 ? all.length : before).find(same);
  if (!twin) return null;
  const as = accountOf(m);
  return `same machine as ${twin.name}${as && as !== accountOf(twin) ? `, as ${as}` : ""}`;
};

/** The line that removes a machine's old host key from known_hosts: the
 *  native side's (by the name and port ssh looks it up by), else by its
 *  address. */
export const forgetKeyLine = (m: Machine): string => m.reach?.forgetKey ?? `ssh-keygen -R ${m.reach?.hostname ?? m.target.split("@").pop()}`;

/** "Show in Finder", as this computer calls it. */
export const revealWords = (platform: string): string => (platform === "macos" ? "Show in Finder" : platform === "windows" ? "Show in File Explorer" : "Show in folder");

/** How long until `at`: "in 40 s", "in 3 min", "now". */
export const inTime = (at: number, now: number = Date.now()): string => {
  const s = Math.round((at - now) / 1000);
  if (s <= 0) return "now";
  return s < 90 ? `in ${s} s` : `in ${Math.round(s / 60)} min`;
};

/** Free space, as a person says it: "1.7 TB", "180 MB". */
export const freeText = (kb: number): string => {
  const units = ["KB", "MB", "GB", "TB"];
  let v = kb;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
};

/** "3 sessions", "1 session". */
export const sessionsCount = (n: number): string => `${n} ${n === 1 ? "session" : "sessions"}`;

/** Whether a failure is its host key having changed: `ssh-keygen -R` is the way out. */
export const keyChanged = (m: Machine): boolean => m.state.kind === "failed" && /host key isn.t the one/.test(m.state.message);

/** Whether a failure is this computer's SSH key: locked, or turned away. */
export const keyRefused = (m: Machine): boolean => m.state.kind === "failed" && /turned your SSH key away|ssh-add/.test(m.state.message);

/** What ssh said, as the end of a sentence: "Connection timed out after
 *  15 s." from "ssh: connect to host 10.0.3.14 port 22: Connection timed
 *  out". */
export const sshTail = (said: string): string => {
  const words = said.replace(/^ssh:\s*/, "").replace(/^connect to host \S+ port \d+:\s*/, "").trim();
  const tail = /^Connection timed out$/i.test(words) ? `${words} after 15 s` : words;
  return tail ? `${tail[0]!.toUpperCase()}${tail.slice(1).replace(/\.$/, "")}.` : "";
};

/** Why a machine is offline, in a sentence or two: Desk's words for it
 *  (through its jump host), then ssh's. */
export const offlineWhy = (m: Machine): string => {
  const via = m.reach?.via ? ` through ${m.reach.via}` : "";
  const desk = m.reason?.split(/[:“]/)[0]?.trim().replace(/\.$/, "");
  const head = desk && /^(SSH|Desk) couldn.t reach/.test(desk) ? `SSH couldn’t reach ${m.name}${via}.` : desk ? `${desk}.` : `SSH couldn’t reach ${m.name}${via}.`;
  return m.said ? `${head} ${sshTail(m.said)}` : head;
};

/** How the row says where a machine stands: its first line (why, in the
 *  machine's own words where Desk has them) and its tone, then what else
 *  is worth a glance. `engines`: who it's signed in as, once read. */
export const rowLines = (
  m: Machine,
  o: { desk: string | null; sessions: number; now?: number; claudeIn?: boolean | null; signedIn?: string | null; twin?: string | null },
): { first: string; tone: "muted" | "blocked"; second: string | null } => {
  const now = o.now ?? Date.now();
  const keep = o.sessions > 0 ? `${o.sessions === 1 ? "its 1 session keeps" : `${o.sessions} sessions keep`} running there` : null;
  switch (m.state.kind) {
    case "ready":
      if (o.claudeIn === false)
        return {
          first: "Needs sign-in: Claude isn’t signed in there yet, so sessions can’t start.",
          tone: "blocked",
          second: ["Connected", m.version && `Desk ${m.version}`, o.twin].filter(Boolean).join(" · "),
        };
      return {
        first: ["Connected", sessionsCount(o.sessions), m.version && `Desk ${m.version}`, m.system && `Linux ${m.system.arch}`].filter(Boolean).join(" · "),
        tone: "muted",
        second: [o.signedIn, o.twin].filter(Boolean).join(" · ") || null,
      };
    case "connecting":
      return { first: "Connecting… Desk gives up after 15 s and says why.", tone: "muted", second: null };
    case "adding":
      return { first: "Being set up…", tone: "muted", second: null };
    case "unreachable":
      return {
        first: `Offline: ${offlineWhy(m)}`,
        tone: "blocked",
        second: [keep, m.lastConnected && `last connected ${clock(m.lastConnected, now)}`, m.nextTry && `next try ${inTime(m.nextTry, now)}`].filter(Boolean).join(" · ") || null,
      };
    case "updating":
      return { first: `Updating Desk${o.desk ? ` to ${o.desk}` : ""}… its sessions carry on`, tone: "muted", second: null };
    case "newer":
      return { first: `It runs a newer Desk${m.version ? ` (${m.version})` : ""}. Update Desk here to drive it; its sessions keep running.`, tone: "blocked", second: null };
    case "failed":
      if (keyRefused(m))
        return { first: `Offline: your SSH key is locked, or ${m.name} turned it away. Run ssh-add in a terminal, then Reconnect.`, tone: "blocked", second: keep };
      return { first: m.state.message || m.reason || "Desk couldn’t set it up.", tone: "blocked", second: keep };
  }
};
