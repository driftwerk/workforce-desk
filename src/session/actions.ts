import { useDesk } from "../hub/store";
import type { Session, SessionState } from "../hub/types";
import { answersInDesk } from "../engines/engines";
import { askLifecycle } from "./lifecycle";

export interface SessionAction {
  label: "Interrupt" | "Stop" | "Resume" | "Resume in Desk";
  run: () => void;
}

/** States a session is only in while its process runs (here, or in another
 *  terminal). */
const RUNNING: ReadonlySet<SessionState> = new Set(["starting", "working", "blocked", "asking", "done", "idle"]);
export const runs = (s: Session): boolean => s.live || RUNNING.has(s.state);

/** Whether Desk can pick a session's conversation up: it isn't running
 *  anywhere, it has one (a CLI session id), and its engine resumes by id. A
 *  session from another terminal resumes in Desk as the same session. */
export const resumable = (s: Session): boolean => !runs(s) && !!s.cliSessionId && s.caps?.resume !== "none";

/** What a session offers wherever it shows: Interrupt while it works (Esc in
 *  its terminal, which ends the turn and nothing else); Stop while one Desk
 *  started runs (a tracked one's shell is the person's, so it has none);
 *  Resume once it runs nowhere, whoever started it ("Resume in Desk" for
 *  one from another terminal). Each only where its engine's caps allow it
 *  (an older hub sends none: Claude Code and Codex allow all three). */
export function sessionActions(session: Session): SessionAction[] {
  const call = (act: "interrupt" | "stop" | "resume") => () => {
    const { hub, fail } = useDesk.getState();
    hub?.[act](session.id).catch(fail);
  };
  if (session.live) {
    return [
      ...(session.state === "working" && session.caps?.interrupt !== "none" ? [{ label: "Interrupt" as const, run: call("interrupt") }] : []),
      ...(session.terminalId ? [] : [{ label: "Stop" as const, run: call("stop") }]),
    ];
  }
  return resumable(session) ? [{ label: session.origin === "external" ? "Resume in Desk" : "Resume", run: call("resume") }] : [];
}

export interface LifecycleAction {
  label: "End session…" | "Remove…" | "Stop tracking…";
  run: () => void;
}

/** Whether a session can be ended from Desk: one Desk runs (not in one of
 *  its terminals, whose shell is the person's), or one that has stopped and
 *  isn't closed yet. One running in another terminal ends there. */
export const endable = (s: Session): boolean =>
  s.origin === "desk" && !s.terminalId && s.state !== "closed" && (s.live || !RUNNING.has(s.state));

/** Ending, removing: what a session offers in its menus and card, each
 *  asking first where it should. A session running in another terminal is
 *  only stopped being tracked: it keeps running there. */
export function lifecycleActions(session: Session): LifecycleAction[] {
  const elsewhere = !session.live && RUNNING.has(session.state);
  return [
    ...(endable(session) ? [{ label: "End session…" as const, run: () => endSession(session) }] : []),
    {
      label: elsewhere ? ("Stop tracking…" as const) : ("Remove…" as const),
      run: () => askLifecycle({ kind: "remove", sessionId: session.id }),
    },
  ];
}

/** Ends a session: at once when it isn't working, else after asking. */
export function endSession(session: Session): void {
  if (session.live && session.state !== "done" && session.state !== "idle") {
    askLifecycle({ kind: "end", sessionId: session.id });
    return;
  }
  const { hub, fail } = useDesk.getState();
  hub?.end(session.id).catch(fail);
}

/** Whether a session's approvals can be answered in Desk from its options:
 *  a Claude Code session started by hand in a Desk terminal, which asks in
 *  that terminal unless the person says otherwise. */
export const approvalsSwitchable = (session: Session): boolean =>
  session.live && answersInDesk(session.engine, session.caps) && !!session.terminalId;

/** Switches where a session's approvals are answered: in Desk (the Floor, the
 *  card, the overseer within its level) or in its terminal. */
export const setApprovalsInDesk = (session: Session, inDesk: boolean): void => {
  const { hub, fail } = useDesk.getState();
  hub?.update(session.id, { approvals: inDesk ? "desk" : "terminal" }).catch(fail);
};
