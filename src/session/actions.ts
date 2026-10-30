import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";

export interface SessionAction {
  label: "Stop" | "Resume";
  run: () => void;
}

/** What a session offers wherever it shows: Stop while it runs, Resume once
 *  one Desk started isn't (one in another terminal resumes after it closes). */
export function sessionAction(session: Session): SessionAction | null {
  const call = (act: "stop" | "resume") => () => {
    const { hub, fail } = useDesk.getState();
    hub?.[act](session.id).catch(fail);
  };
  if (session.live) return { label: "Stop", run: call("stop") };
  if (session.origin === "desk") return { label: "Resume", run: call("resume") };
  return null;
}
