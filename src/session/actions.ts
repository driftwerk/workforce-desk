import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { answersInDesk } from "../engines/engines";

export interface SessionAction {
  label: "Interrupt" | "Stop" | "Resume";
  run: () => void;
}

/** What a session offers wherever it shows: Interrupt while it works (Esc in
 *  its terminal, which ends the turn and nothing else); Stop while one Desk
 *  started runs (a tracked one's shell is the person's, so it has none);
 *  Resume once one Desk started isn't running (one in another terminal
 *  resumes after it closes). Each only where its engine's caps allow it
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
  return session.origin === "desk" && session.caps?.resume !== "none" ? [{ label: "Resume", run: call("resume") }] : [];
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
