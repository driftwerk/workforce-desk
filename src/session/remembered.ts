// What New session remembers, in this browser only: the folder last started
// in, and per folder the choices made there (engine, account, group, how it
// asks, the separate copy). A per-person convenience: anything unreadable
// is as if nothing was kept.

import type { Engine } from "../hub/types";

export interface Choices {
  engine?: Engine;
  /** The account picked, or `own` for the CLI's own sign-in. */
  account?: string;
  group?: string;
  approvals?: "desk" | "terminal";
  approveForMe?: boolean;
  fast?: boolean;
  /** The model picked for `engine`; absent, its default. */
  model?: string;
  copy?: boolean;
}

const KEY = "desk.newSession";
/** Most folders remembered: the oldest go first. */
const MAX = 40;

interface Kept {
  last?: string;
  /** The latest at the end. */
  folders?: [string, Choices][];
}

const read = (): Kept => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Kept) : {};
  } catch {
    return {};
  }
};

const write = (k: Kept): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(k));
  } catch {
    /* kept for this time only */
  }
};

/** The folder a session was last started in, on `machine`. */
export const lastFolder = (machine: string): string | null => {
  const last = read().last;
  if (!last) return null;
  const [m, ...rest] = last.split("\n");
  return m === machine && rest.length ? rest.join("\n") : null;
};

const keyOf = (machine: string, folder: string): string => `${machine}\n${folder.replace(/\/+$/, "")}`;

/** What was chosen when a session last started in `folder` on `machine`. */
export const choicesFor = (machine: string, folder: string): Choices => {
  const k = keyOf(machine, folder);
  return read().folders?.find(([f]) => f === k)?.[1] ?? {};
};

/** Keeps `choices` for `folder` on `machine`, and it as the last folder. */
export const remember = (machine: string, folder: string, choices: Choices): void => {
  const k = keyOf(machine, folder);
  const kept = read();
  const folders = (kept.folders ?? []).filter(([f]) => f !== k);
  folders.push([k, choices]);
  write({ last: k, folders: folders.slice(-MAX) });
};

/** A session's name from what it's for: its first few words, as a short
 *  slug ("Fix the login page" is fix-login-page); none when there are none. */
export const nameFromGoal = (goal: string): string => {
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w && !["the", "a", "an", "to", "of", "and", "on", "in", "for", "our", "my"].includes(w));
  return words.slice(0, 4).join("-").slice(0, 40).replace(/-+$/, "");
};

/** The branch a separate copy starts from: Desk's own, named for the goal. */
export const branchFor = (goal: string, name: string): string => `desk/${nameFromGoal(goal) || name || "session"}`;
