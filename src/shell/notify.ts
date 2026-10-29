import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { sessionName } from "../groups/names";
import type { Session, SessionState } from "../hub/types";

/** The notification a state change deserves, if any: a session that starts
 *  needing you, or finishes, while you're looking elsewhere. */
export const notificationFor = (
  before: SessionState | undefined,
  s: Session,
): { title: string; body: string } | null => {
  if (before === undefined || before === s.state) return null;
  const name = sessionName(s.id, s.name);
  if (s.state === "blocked")
    return { title: `${name} needs you`, body: s.pending ? `${s.pending.tool} ${s.pending.detail}`.trim() : "Waiting for an answer" };
  if (s.state === "done" && (before === "working" || before === "blocked"))
    return { title: `${name} is done`, body: s.lastReply?.split("\n")[0] ?? s.goal };
  return null;
};

let allowed: Promise<boolean> | null = null;

const permission = (): Promise<boolean> =>
  (allowed ??= isPermissionGranted().then((g) => g || requestPermission().then((p) => p === "granted")));

export const notify = async (n: { title: string; body: string }): Promise<void> => {
  if (document.hasFocus() || !(await permission())) return;
  sendNotification(n);
};
