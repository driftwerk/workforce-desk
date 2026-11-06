import { useEffect, useId, useState } from "react";
import { useDesk } from "../hub/store";
import { CopyButton } from "../settings/EngineBlocks";
import { useHost } from "../shell/host";
import { CloseButton, Dialog } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { sessionsOn, type Machine } from "./engines";
import type { MachineNative, RemoveEvent } from "./native";
import { sessionsCount, thisComputerLower } from "./words";

type Step = RemoveEvent["step"];
type StepState = RemoveEvent["state"] | "waiting";

/** The lines that uninstall Desk by hand there. */
export const BY_HAND = ["systemctl --user disable --now desk-helper", "~/.local/share/Desk/bin/current/desk-helper --remove-everything"];

const DOT: Record<StepState, string> = { waiting: "dot", running: "dot dot-working", done: "dot dot-done", failed: "dot dot-failed", blocked: "dot dot-blocked" };

/** What each step says, as it goes. */
const words = (step: Step, state: StepState, name: string): string => {
  switch (step) {
    case "stop":
      return state === "done" ? `Stopped Desk’s service on ${name}` : state === "running" ? `Stopping Desk’s service on ${name}…` : `Couldn’t stop Desk’s service on ${name}`;
    case "remove":
      return state === "done" ? "Removed ~/.local/share/Desk" : state === "running" ? "Removing ~/.local/share/Desk…" : state === "waiting" ? "Remove ~/.local/share/Desk" : "Couldn’t remove ~/.local/share/Desk";
    case "linger":
      return state === "done" ? "Turned linger off" : state === "running" ? "Turning linger off…" : state === "blocked" ? "Linger stays on" : "Turn linger off";
    case "forget":
      return state === "done" ? `Forgot ${name} here` : `Forget ${name} here`;
  }
};

/** The machine's own reason in a step's message, without the step's words
 *  the native side put first ("Couldn't remove ~/.local/share/Desk. …"). */
const why = (message: string, said: string): string => {
  const plain = (t: string) => t.replace(/[’‘]/g, "'");
  const m = plain(message);
  const lead = plain(said);
  return m.startsWith(lead) ? message.slice(lead.length).replace(/^[.:]\s*/, "") || message : message;
};

/** "Remove devbox?": forget it here, and choose whether to uninstall Desk
 *  from it too. A machine Desk can't reach can only be forgotten, with the
 *  lines that uninstall it later. An uninstall says each step as it goes;
 *  one that fails says why in place, and nothing is forgotten until it
 *  works or the person removes it without uninstalling. */
export function RemoveMachine({ machine, native, onClose, onRemoved }: { machine: Machine; native: MachineNative; onClose: () => void; onRemoved: () => void }) {
  const here = thisComputerLower(useHost((h) => h.platform));
  const sessions = useDesk((s) => sessionsOn(s.sessions, machine.id).length);
  const reachable = machine.state.kind === "ready" || machine.state.kind === "updateFailed" || machine.state.kind === "newer";
  const [uninstall, setUninstall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Partial<Record<Step, RemoveEvent>> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const name = machine.name;
  const group = useId();

  useEffect(
    () =>
      native.removing((e) => {
        if (e.machine === machine.id) setSteps((now) => ({ ...(now ?? {}), [e.step]: e }));
      }),
    [native, machine.id],
  );

  const failed = !!steps && Object.values(steps).some((e) => e?.state === "failed");
  const forgetOnly = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await native.remove(machine.id);
      onRemoved();
    } catch (e) {
      setProblem(plainError(e));
    } finally {
      setBusy(false);
    }
  };
  const go = async () => {
    if (!uninstall) return forgetOnly();
    setBusy(true);
    setProblem(null);
    setSteps({});
    try {
      await native.uninstall(machine.id);
      onRemoved();
    } catch (e) {
      // The step that failed says why; anything else is said under them.
      setProblem(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  const checks: Step[] = ["stop", "remove", "linger", "forget"];
  return (
    <Dialog
      onClose={() => !busy && onClose()}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h2 id={id} className="display-lg">
              Remove {name}?
            </h2>
          </span>
          <CloseButton onClose={() => !busy && onClose()} />
        </header>
      )}
    >
      <div className="dialog-scroll">
        {!steps && (
          <p>
            Desk on {here} forgets {name} and stops showing its {sessionsCount(sessions)}.
          </p>
        )}
        {(
          <>
            <div className="remove-choices" role="radiogroup" aria-labelledby={group}>
              <span id={group} hidden>
                What happens on {name}
              </span>
              <button type="button" role="radio" aria-checked={!uninstall} className="remove-choice" disabled={busy} onClick={() => setUninstall(false)}>
                <span className="pick-ring" aria-hidden="true" />
                <span className="remove-choice-text">
                  <b>Leave Desk running on {name}</b>
                  <span className="small muted">Its sessions keep running. Adding {name} again picks them up.</span>
                </span>
              </button>
              <button type="button" role="radio" aria-checked={uninstall} className="remove-choice" disabled={!reachable || busy} onClick={() => setUninstall(true)}>
                <span className="pick-ring" aria-hidden="true" />
                <span className="remove-choice-text">
                  <b>Also uninstall Desk from {name}</b>
                  <span className="small muted">
                    {reachable
                      ? `Ends its ${sessionsCount(sessions)}, stops Desk’s service there and removes ~/.local/share/Desk with its sign-ins and memory. Your files, repos, Claude Code and Codex stay.`
                      : `Desk can’t reach ${name} right now, so it can only forget it here.`}
                  </span>
                </span>
              </button>
            </div>
            {!reachable && !steps && (
              <div className="remove-later">
                <span className="small">To uninstall it later, run these on {name}:</span>
                {BY_HAND.map((line) => (
                  <span key={line} className="machine-line">
                    <code className="mono small">{line}</code>
                    <CopyButton text={line} />
                  </span>
                ))}
              </div>
            )}
          </>
        )}
        {steps && (
          <>
            <ul className="machine-checks" aria-label={`Uninstalling Desk from ${name}`} aria-live="polite">
              {checks.map((step) => {
                const e = steps[step];
                const state: StepState = e?.state ?? "waiting";
                return (
                  <li key={step} className="machine-check">
                    <span className={DOT[state]} aria-hidden="true" />
                    <span className="machine-check-text">
                      <span className={state === "waiting" ? "faint" : state === "failed" ? "state-blocked" : undefined}>
                        {state === "failed" && e?.message ? `${words(step, state, name)}: ${why(e.message, words(step, state, name))}` : words(step, state, name)}
                      </span>
                      {state === "blocked" && e?.message && <span className="small muted">{e.message}</span>}
                      {e?.line && (
                        <span className="machine-line">
                          <code className="mono small">{e.line}</code>
                          <CopyButton text={e.line} />
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {problem && !failed && (
          <p className="small state-blocked" role="alert">
            {problem}
          </p>
        )}
      </div>
      <footer className="dialog-foot">
        <span className={`dialog-foot-note small ${failed ? "state-blocked" : ""}`}>
          {failed ? "Nothing is forgotten yet. Try again, or remove it without uninstalling." : ""}
        </span>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        {failed && (
          <button type="button" className="btn" disabled={busy} onClick={() => void forgetOnly()}>
            Remove without uninstalling
          </button>
        )}
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void go()}>
          {failed ? "Try again" : `Remove ${name}`}
        </button>
      </footer>
    </Dialog>
  );
}
