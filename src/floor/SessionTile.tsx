import { useSessionName } from "../groups/names";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { Approval } from "../session/Approval";
import { Mark } from "../ui/Mark";
import { plain } from "../ui/plain";

const LABEL: Record<Session["state"], string> = {
  starting: "starting",
  working: "working",
  blocked: "needs you",
  done: "done",
  idle: "idle",
  interrupted: "interrupted",
  stopped: "stopped",
  closed: "closed",
};

export interface Group {
  title: string;
  match: (s: Session) => boolean;
}

/** How sessions are grouped on the Floor, first match wins. */
export const GROUPS: Group[] = [
  { title: "Needs you", match: (s) => s.state === "blocked" },
  { title: "Working", match: (s) => s.state === "working" || s.state === "starting" },
  { title: "Recently done and idle", match: (s) => (s.state === "done" || s.state === "idle") && s.live },
  { title: "In other terminals", match: (s) => s.origin === "external" && s.live === false && s.state !== "closed" },
  { title: "Not running", match: (s) => !s.live && s.origin === "desk" },
];

const home = (s: Session): string => (s.origin === "external" ? "other terminal" : "local");

const task = (s: Session): string => s.goal || (s.lastPrompt && plain(s.lastPrompt)) || "No goal yet";

const log = (s: Session): string | null =>
  s.currentTool ? `● ${s.currentTool}` : s.lastReply ? plain(s.lastReply).split("\n").slice(0, 3).join("\n") : null;

export function Tile({ session }: { session: Session }) {
  const open = useDesk((s) => s.open);
  const name = useSessionName(session.id, session.name);
  const text = log(session);
  return (
    <article className={`tile tile-${session.state}`}>
      <button type="button" className="tile-open" onClick={() => open(session.id)}>
        <Mark name={name} engine={session.engine} state={session.state} size="lg" />
        <span className="tile-name">
          <span className="mono tile-title">{name}</span>
          <span className={`tile-state state-${session.state}`}>
            {LABEL[session.state]} · {home(session)}
          </span>
        </span>
      </button>
      <span className="tile-task">{task(session)}</span>
      {text && <pre className="tile-log">{text}</pre>}
      {session.pending && <Approval session={session} compact />}
    </article>
  );
}
