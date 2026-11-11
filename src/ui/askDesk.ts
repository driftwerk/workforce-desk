import { useChat } from "../chat/store";
import { localKey, openLocalDm } from "../overview/people";
import { useOverview } from "../overview/store";
import type { Problem } from "./problem";
import { redact } from "./redact";

/** What Desk's agent is told when a problem is handed over: what happened,
 *  what Desk was doing, and the raw text it can act on. */
export const askText = (p: Problem): string =>
  redact(
    [
    "Something went wrong in Desk and I’d like you to fix it, or tell me exactly what to do.",
    "",
    `What I saw: ${p.plain}`,
    ...(p.what ? [`What I was doing: ${p.what}`] : []),
    ...(p.fix && !p.fix.ask ? [`The button Desk offered was: ${p.fix.label}`] : []),
    ...(p.details ? ["", "The raw error:", p.details] : []),
    ].join("\n"),
  );

/** Whether Desk's agent is there to ask. */
export const useCanAskDesk = (): boolean => useOverview((s) => !!s.manager?.agentId);

/** Opens Desk’s chat with the problem written in it. False when there's no
 *  Desk agent on this computer to ask. */
export function askDesk(p: Problem): boolean {
  const id = useOverview.getState().manager?.agentId;
  const key = id ? localKey(id) : null;
  if (!id || !key) return false;
  openLocalDm(id);
  const text = askText(p);
  // The conversation opens asynchronously; send once it is up.
  const attempt = (n: number) => {
    if (!useChat.getState().send(key, text) && n < 40) setTimeout(() => attempt(n + 1), 150);
  };
  attempt(0);
  return true;
}
