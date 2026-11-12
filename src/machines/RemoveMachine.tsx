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
    case "sign_out":
      return state === "done"
        ? `Signed Codex out on ${name}`
        : state === "running"
          ? `Signing Codex out on ${name}…`
          : state === "waiting"
            ? `Sign Codex out on ${name}`
            : state === "blocked"
              ? `Codex may still be signed in on ${name}`
              : `Couldn’t sign Codex out on ${name}`;
    case "remove":
      return state === "done"
        ? "Removed Desk’s folder, with the Claude sign-ins it kept"
        : state === "running"
          ? "Removing Desk’s folder and the Claude sign-ins it kept…"
          : state === "waiting"
            ? "Remove Desk’s folder and the Claude sign-ins it kept"
            : "Couldn’t remove ~/.local/share/Desk";
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
  // An uninstall that stopped partway: Desk there is held, stopped and
  // perhaps half gone, and uninstalling again is what finishes it.
  const held = machine.state.kind === "failed" && machine.state.message.startsWith("Uninstalling stopped partway");
  const reachable = held || machine.state.kind === "ready" || machine.state.kind === "updateFailed" || machine.state.kind === "newer";
  const [uninstall, setUninstall] = useState(held);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Partial<Record<Step, RemoveEvent>> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Said when nothing was uninstalled after all (a no, or Cancel). */
  const [kept, setKept] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const name = machine.name;
  // "its 3 sessions", never "its 0 sessions".
  const its = sessions > 0 ? ` and stops showing its ${sessionsCount(sessions)}` : "";
  const ends = sessions > 0 ? `Ends its ${sessionsCount(sessions)}, stops` : "Stops";
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
    setKept(false);
    setCancelling(false);
    setSteps({});
    try {
      if (await native.uninstall(machine.id)) return onRemoved();
      // A no to the question, or Cancel before anything was removed.
      setSteps(null);
      setKept(true);
    } catch (e) {
      // The step that failed says why; anything else is said under them.
      setProblem(plainError(e));
    } finally {
      setBusy(false);
      setCancelling(false);
    }
  };
  /** Cancel while it uninstalls: only before it removes anything. */
  const stoppable = busy && !!steps && !steps.remove;
  const cancel = () => {
    if (!busy) return onClose();
    if (!stoppable) return;
    setCancelling(true);
    native.cancelUninstall(machine.id).catch((e: unknown) => {
      setCancelling(false);
      setProblem(plainError(e));
    });
  };

  const checks: Step[] = ["stop", "sign_out", "remove", "linger", "forget"];
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
            Desk on {here} forgets {name}
            {its}.
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
                  <span className="small muted">
                    Its sessions keep running, and so do the copies of your accounts’ sign-ins there. Adding {name} again picks them up.
                  </span>
                </span>
              </button>
              <button type="button" role="radio" aria-checked={uninstall} className="remove-choice" disabled={!reachable || busy} onClick={() => setUninstall(true)}>
                <span className="pick-ring" aria-hidden="true" />
                <span className="remove-choice-text">
                  <b>Also uninstall Desk from {name}</b>
                  <span className="small muted">
                    {reachable
                      ? `${ends} Desk’s service there, signs Claude and Codex out there, and removes Desk’s folder with its memory. Your files, repos, Claude Code and Codex stay.`
                      : `Desk can’t reach ${name} right now, so it can only forget it here.`}
                  </span>
                </span>
              </button>
            </div>
            {!steps && !reachable && (
              <p className="small muted">
                {name} keeps copies of your accounts’ Claude sign-ins until Desk is uninstalled there. Desk can’t reach it to end them: if {name} is lost, or you no longer
                trust it, revoke them at claude.ai.
              </p>
            )}
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
        {kept && !steps && (
          <p className="small muted" role="status">
            Nothing was uninstalled: Desk on {name} is as it was.
          </p>
        )}
        {steps && (
          <>
            {busy && <p className="small faint">Each step stops after 3 minutes and says why. Cancel works until Desk starts removing its folder there.</p>}
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
        <button type="button" className="btn btn-ghost" disabled={(busy && !stoppable) || cancelling} onClick={cancel}>
          {cancelling ? "Cancelling…" : "Cancel"}
        </button>
        {failed && (
          <button type="button" className="btn" disabled={busy} onClick={() => void forgetOnly()}>
            Remove without uninstalling
          </button>
        )}
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void go()}>
          {failed || (held && uninstall) ? "Try uninstalling again" : `Remove ${name}`}
        </button>
      </footer>
    </Dialog>
  );
}
