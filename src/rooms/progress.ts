import type { RoomDraft } from "../hub/store";
import type { Step } from "../hub/types";

// What an answer on its way has done so far: a few tools as chips while
// it's short, a list of steps with their times once it runs long, and what
// a posted answer's turn ran, kept on it.

export type StepState = "running" | "done" | "failed" | "unfinished";

export interface Progress {
  /** Chips while short; a step list once long. */
  mode: "chips" | "steps";
  /** "Working · 4m 10s · 6 steps", "Waiting on you", "Stalled · 40s",
   *  "Stopped · 2 steps". */
  header: string;
  /** The header without its clock, for a screen reader: it changes only as
   *  the answer's state or its steps do. */
  status: string;
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
const OVER: Partial<Record<RoomDraft["state"], string>> = { failed: "Failed", interrupted: "Interrupted", stopped: "Stopped" };

export const progressOf = (d: RoomDraft, now: number, asked = false): Progress => {
  const over = d.state === "failed" || d.state === "interrupted" || d.state === "stopped";
  // Asked but not yet answering: nothing has run, and no clock is started.
  const waitingTurn = d.state === "queued" || d.state === "connecting" || d.state === "busy";
  const waiting = !over && (d.prompts.length > 0 || asked);
  const steps = d.tools.map((t) => ({
    name: t.name,
    state: (t.done ? "done" : over ? "unfinished" : "running") as StepState,
    secs:
      t.startedAt === undefined ? null : t.done ? (t.endedAt === undefined ? null : (t.endedAt - t.startedAt) / 1000) : over ? null : (now - t.startedAt) / 1000,
  }));
  const counted = steps.length ? count(steps.length) : null;
  const [label, clock, steps_] = waiting
    ? ["Waiting on you", null, null]
    : over
      ? [OVER[d.state]!, null, counted]
      : waitingTurn
        ? ["Queued", null, null]
        : d.state === "stalled"
          ? ["Stalled", elapsed(now - (d.stalledSince ?? now)), null]
          : ["Working", elapsed(now - d.since), counted];
  const header = [label, clock, steps_].filter(Boolean).join(" · ");
  // A step list once it has run long or run many tools; one over keeps it
  // only for the steps it had, and one not yet answering has none.
  const long = !waitingTurn && (now - d.since > STEP_LIST_AFTER_MS || d.tools.length > STEP_LIST_AFTER_TOOLS) && (!over || steps.length > 0);
  return { mode: long || waiting ? "steps" : "chips", header, status: [label, steps_].filter(Boolean).join(" · "), waiting, steps };
};

/** A posted message's steps, for its disclosure. */
export const stepsOf = (steps: readonly Step[]): Progress["steps"] =>
  steps.map((s) => ({ name: s.tool, state: s.ok ? "done" : "failed", secs: s.ms / 1000 }));

/** "1.2s", "4m 10s"; nothing without a time. */
export const secsLabel = (secs: number | null): string => (secs === null ? "" : secs < 10 ? `${secs.toFixed(1)}s` : elapsed(secs * 1000));
