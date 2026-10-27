import { RichMarkdown } from "@workforce/rich";
import { useState } from "react";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { Mark } from "../ui/Mark";
import { Approval } from "./Approval";
import { Terminal } from "./Terminal";

const ENGINE: Record<Session["engine"], string> = { claude: "Claude Code", codex: "Codex" };

const where = (s: Session): string =>
  [ENGINE[s.engine], s.branch ? `branch ${s.branch}` : s.cwd.replace(/^\/Users\/[^/]+/, "~")].join(" · ");

export function SessionCard({ session }: { session: Session }) {
  const { hub, fail, open } = useDesk();
  const [editingGoal, setEditingGoal] = useState(false);
  const [goal, setGoal] = useState(session.goal);
  const saveGoal = () => {
    setEditingGoal(false);
    if (goal !== session.goal) hub?.update(session.id, { goal }).catch(fail);
  };
  return (
    <aside className="session-card" aria-label={`Session ${session.name}`}>
      <header className="session-head">
        <Mark name={session.name} engine={session.engine} state={session.state} />
        <span className="session-title">
          <span className="mono">{session.name}</span>
          <span className="faint small">{where(session)}</span>
        </span>
        <span className="session-actions">
          {session.live ? (
            <button type="button" className="link" onClick={() => hub?.stop(session.id).catch(fail)}>
              Stop
            </button>
          ) : (
            session.origin === "desk" && (
              <button type="button" className="link" onClick={() => hub?.resume(session.id).catch(fail)}>
                Resume
              </button>
            )
          )}
          <button type="button" className="link" onClick={() => open(null)}>
            Close
          </button>
        </span>
      </header>
      <div className="session-goal">
        {editingGoal ? (
          <input
            autoFocus
            value={goal}
            placeholder="What is this session for?"
            onChange={(e) => setGoal(e.target.value)}
            onBlur={saveGoal}
            onKeyDown={(e) => e.key === "Enter" && saveGoal()}
          />
        ) : (
          <button type="button" className="goal-text" onClick={() => setEditingGoal(true)}>
            {session.goal || <span className="faint">Add a goal so you know what this one is for</span>}
          </button>
        )}
      </div>
      {session.live ? (
        <Terminal key={session.id} sessionId={session.id} />
      ) : (
        <div className="terminal-idle">
          <p className="muted">
            {session.origin === "external"
              ? "Running in another terminal. Desk shows its progress; once it's closed you can resume it here."
              : session.state === "interrupted"
                ? "This session was working when it stopped. Resume picks up the same conversation."
                : "Not running. Resume picks up the same conversation."}
          </p>
          {session.lastReply && (
            <div className="transcript-tail rich">
              <RichMarkdown text={session.lastReply} />
            </div>
          )}
        </div>
      )}
      <Approval session={session} />
    </aside>
  );
}
