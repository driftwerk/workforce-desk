import type { SessionState } from "../hub/types";

/** A session's state in a word or two: in a pane's or the side panel's
 *  header, and wherever sessions are picked. */
export const STATE_LABEL: Record<SessionState, string> = {
  starting: "starting",
  working: "working",
  blocked: "needs you",
  asking: "needs you · asked",
  done: "done",
  idle: "idle",
  interrupted: "interrupted",
  stopped: "stopped",
  closed: "closed",
};
