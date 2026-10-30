import { RichMarkdown } from "@workforce/rich";
import { useState } from "react";
import { useSessionName } from "../groups/names";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { PutInGrid } from "../grids/PutInGrid";
import { SidePanel } from "../panels/Stage";
import { Mark } from "../ui/Mark";
import { sessionAction } from "./actions";
import { Approval } from "./Approval";
import { Terminal } from "./Terminal";

const ENGINE: Record<Session["engine"], string> = { claude: "Claude Code", codex: "Codex" };

const where = (s: Session): string =>
  [ENGINE[s.engine], s.branch ? `branch ${s.branch}` : s.cwd.replace(/^\/Users\/[^/]+/, "~")].join(" · ");

export function SessionCard({ session }: { session: Session }) {
  const { hub, fail, open } = useDesk();
  const name = useSessionName(session.id, session.name);
  const action = sessionAction(session);
  const [editingGoal, setEditingGoal] = useState(false);
  const [goal, setGoal] = useState(session.goal);
  const saveGoal = () => {
    setEditingGoal(false);
    if (goal !== session.goal) hub?.update(session.id, { goal }).catch(fail);
  };
  return (
    <SidePanel
      className="session-card"
      label={`Session ${name}`}
      noun="this session"
      onClose={() => open(null)}
      title={
        <>
          <Mark name={name} engine={session.engine} state={session.state} />
          <span className="session-title">
            <span className="mono">{name}</span>
            <span className="faint small">{where(session)}</span>
          </span>
        </>
      }
      actions={
        <>
          {action && (
            <button type="button" className="link" onClick={action.run}>
              {action.label}
            </button>
          )}
          <PutInGrid content={{ kind: "session", sessionId: session.id }} label="Put this session in a grid" onShown={() => open(null)} />
        </>
      }
    >
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
      <SessionBody session={session} />
      <Approval session={session} />
    </SidePanel>
  );
}

/** What a session shows: its terminal while it runs (the Desk terminal it
 *  was started in, for a tracked one), else why it isn't running and the
 *  last thing it said. */
export function SessionBody({ session, autoFocus = true }: { session: Session; autoFocus?: boolean }) {
  return session.live ? (
    session.terminalId ? (
      <Terminal key={session.terminalId} terminalId={session.terminalId} autoFocus={autoFocus} />
    ) : (
      <Terminal key={session.id} sessionId={session.id} autoFocus={autoFocus} />
    )
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
  );
}
