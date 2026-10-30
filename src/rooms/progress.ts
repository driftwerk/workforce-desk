import type { RoomDraft } from "../hub/store";
import type { Step } from "../hub/types";

// What an answer on its way has done so far: a few tools as chips while
// it's short, a list of steps with their times once it runs long, and what
// a posted answer's turn ran, kept on it.

export type StepState = "running" | "done" | "failed" | "unfinished";

export interface Progress {
  /** Chips while short; a step list once long. */
  mode: "chips" | "steps";
  /** "Working · 4m 10s · 6 steps", "Waiting on you", "Stalled · 40s". */
  header: string;
  waiting: boolean;
  steps: { name: string; state: StepState; secs: number | null }[];
}

/** A draft shows its steps as a list after this long, or past this many tools. */
export const STEP_LIST_AFTER_MS = 20_000;
export const STEP_LIST_AFTER_TOOLS = 3;

/** "40s", "4m 10s". */
export const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

const count = (n: number) => `${n} step${n === 1 ? "" : "s"}`;

/** A draft's progress at `now`; `asked` when a Floor need placed in its
 *  thread names its member. */
export const progressOf = (d: RoomDraft, now: number, asked = false): Progress => {
  const over = d.state === "failed" || d.state === "interrupted" || d.state === "stopped";
  const waiting = !over && (d.prompts.length > 0 || asked);
  const steps = d.tools.map((t) => ({
    name: t.name,
    state: (t.done ? "done" : over ? "unfinished" : "running") as StepState,
    secs:
      t.startedAt === undefined ? null : t.done ? (t.endedAt === undefined ? null : (t.endedAt - t.startedAt) / 1000) : over ? null : (now - t.startedAt) / 1000,
  }));
  const header = waiting
    ? "Waiting on you"
    : d.state === "stalled"
      ? `Stalled · ${elapsed(now - (d.stalledSince ?? now))}`
      : `Working · ${elapsed(now - d.since)}${steps.length ? ` · ${count(steps.length)}` : ""}`;
  const long = now - d.since > STEP_LIST_AFTER_MS || d.tools.length > STEP_LIST_AFTER_TOOLS;
  return { mode: long || waiting ? "steps" : "chips", header, waiting, steps };
};

/** A posted message's steps, for its disclosure. */
export const stepsOf = (steps: readonly Step[]): Progress["steps"] =>
  steps.map((s) => ({ name: s.tool, state: s.ok ? "done" : "failed", secs: s.ms / 1000 }));

/** "1.2s", "4m 10s"; nothing without a time. */
export const secsLabel = (secs: number | null): string => (secs === null ? "" : secs < 10 ? `${secs.toFixed(1)}s` : elapsed(secs * 1000));
