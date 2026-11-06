import { useState } from "react";
import { plainError } from "../ui/plainError";
import type { Machine } from "./engines";
import type { MachineNative } from "./native";

const DOT = { waiting: "dot", running: "dot dot-working", done: "dot dot-done", failed: "dot dot-failed" } as const;

/** What each step of an update says, before and while it runs. */
const said = (key: string, m: Machine): string => {
  const to = m.update?.to ?? "";
  switch (key) {
    case "download":
      return `Desk ${to} for Linux ${m.system?.arch ?? ""}`.trim();
    case "copy":
      return `Copy it to ${m.name}`;
    case "switch":
      return "Switch over: Desk restarts there in seconds; sessions stay open";
    default:
      return "Reconnect";
  }
};

/** A machine's update, step by step (the Update board): each step's dot
 *  and words, and Cancel update until it switches over. */
export function UpdateSteps({ machine, native }: { machine: Machine; native: MachineNative }) {
  const [problem, setProblem] = useState<string | null>(null);
  const run = machine.update;
  if (!run) return null;
  const cancellable = machine.state.kind === "updating" && run.steps.some((s) => (s.key === "download" || s.key === "copy") && s.state === "running");
  return (
    <div className="update-steps">
      <ul className="machine-checks" aria-label={`Updating ${machine.name}`}>
        {run.steps.map((s) => (
          <li key={s.key} className="machine-check">
            <span className={DOT[s.state]} aria-hidden="true" />
            <span className={s.state === "waiting" ? "faint" : s.state === "failed" ? "state-blocked" : undefined}>
              {s.state === "failed" ? `${said(s.key, machine)}: ${s.detail ?? ""}` : (s.detail ?? said(s.key, machine))}
            </span>
          </li>
        ))}
      </ul>
      {machine.state.kind === "updating" && (
        <span className="small faint">
          {cancellable && (
            <>
              <button
                type="button"
                className="link small"
                onClick={() => {
                  setProblem(null);
                  native.cancelUpdate(machine.id).catch((e: unknown) => setProblem(plainError(e)));
                }}
              >
                Cancel update
              </button>{" "}
            </>
          )}
          Works until the switch-over. Getting Desk stops after 10 minutes, each other step after 3, and says why.
        </span>
      )}
      {problem && (
        <span className="small state-blocked" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}
