import { RichMarkdown } from "@workforce/rich";
import { useState } from "react";
import { useSessionName } from "../groups/names";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { useGrids } from "../grids/store";
import { addToGrid } from "../grids/windows";
import { SidePanel } from "../panels/Stage";
import { Mark } from "../ui/Mark";
import { Menu, type MenuEntry } from "../ui/Menu";
import { Approval } from "./Approval";
import { Terminal } from "./Terminal";

const ENGINE: Record<Session["engine"], string> = { claude: "Claude Code", codex: "Codex" };

const where = (s: Session): string =>
  [ENGINE[s.engine], s.branch ? `branch ${s.branch}` : s.cwd.replace(/^\/Users\/[^/]+/, "~")].join(" · ");

export function SessionCard({ session }: { session: Session }) {
  const { hub, fail, open } = useDesk();
  const name = useSessionName(session.id, session.name);
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
          <PutInGrid session={session} />
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

/** "Put in grid ▾": the grids, and a new one. The session goes to the
 *  grid as a sidebar item's "Add to grid" sends it, and is shown there. */
export function PutInGrid({ session }: { session: Session }) {
  const [menu, setMenu] = useState<{ x: number; y: number; from: HTMLElement } | null>(null);
  const order = useGrids((s) => s.order);
  const grids = useGrids((s) => s.grids);
  const put = (gridId: string | null) => {
    if (addToGrid({ kind: "session", sessionId: session.id }, gridId).shown) useDesk.getState().open(null);
  };
  const entries: MenuEntry[] = [
    ...order.flatMap((id): MenuEntry[] => (grids[id] ? [{ kind: "item", label: grids[id]!.name, onSelect: () => put(id) }] : [])),
    ...(order.some((id) => grids[id]) ? [{ kind: "separator" as const }] : []),
    { kind: "item", label: "New grid", onSelect: () => put(null) },
  ];
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost gbtn rpanel-put"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-label="Put this session in a grid"
        title="Put it in a grid"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 4, from: e.currentTarget });
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="1.5" y="1.5" width="11" height="11" rx="2" />
          <path d="M7 1.5v11M1.5 7h11" />
        </svg>
        <span className="rpanel-put-label">Put in grid</span> ▾
      </button>
      {menu && (
        <Menu
          label="Put in grid"
          at={menu}
          entries={entries}
          onClose={(refocus) => {
            if (refocus) menu.from.focus();
            setMenu(null);
          }}
        />
      )}
    </>
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
