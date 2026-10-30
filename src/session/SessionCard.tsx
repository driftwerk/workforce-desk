import { RichMarkdown } from "@workforce/rich";
import { useState } from "react";
import { backgroundLine, backgroundOf, lookOf } from "../floor/background";
import { useSessionName } from "../groups/names";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { PutInGrid } from "../grids/PutInGrid";
import { shownGrid, useGrids } from "../grids/store";
import { placesOf, type Place } from "../grids/where";
import { addToGrid, goTo } from "../grids/windows";
import { sessionItem } from "../groups/model";
import { SidePanel } from "../panels/Stage";
import { Mark } from "../ui/Mark";
import { sessionAction } from "./actions";
import { Approval } from "./Approval";
import { Terminal } from "./Terminal";
import { homeShort } from "../ui/paths";

const ENGINE: Record<Session["engine"], string> = { claude: "Claude Code", codex: "Codex" };

const where = (s: Session): string => {
  const background = backgroundOf(s);
  return [ENGINE[s.engine], s.branch ? `branch ${s.branch}` : homeShort(s.cwd), background && backgroundLine(background)]
    .filter(Boolean)
    .join(" · ");
};

export function SessionCard({ session }: { session: Session }) {
  const { hub, fail, open, sessions } = useDesk();
  const name = useSessionName(session.id, session.name);
  const action = sessionAction(session);
  const order = useGrids((s) => s.order);
  const grids = useGrids((s) => s.grids);
  const places = placesOf({ order, grids }, sessions, sessionItem(session.id));
  // Running in a Desk terminal that no pane shows (nor the session itself).
  const loose = !places.length && session.live && session.terminalId ? session.terminalId : null;
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
          <Mark name={name} engine={session.engine} state={lookOf(session)} />
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
          {!places.length && !loose && <PutInGrid content={{ kind: "session", sessionId: session.id }} label="Put this session in a grid" onShown={() => open(null)} />}
        </>
      }
    >
      {(places.length > 0 || loose) && <ShownIn places={places} loose={loose} onShown={() => open(null)} />}
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

/** One of each kind of place per grid: a grid holding the session in a
 *  pane of its own, or the terminal it runs in. */
const perGrid = (places: Place[], terminal: boolean): Place[] =>
  places.filter((p, i) => (p.content.kind === "terminal") === terminal && places.findIndex((q) => q.gridId === p.gridId && q.content.kind === p.content.kind) === i);

/** Where the session already is (see `placesOf`), each with a way there:
 *  its own pane in a grid, the terminal in a grid it runs in, or a Desk
 *  terminal no grid shows, which is put in the grid shown now. `onShown`
 *  closes the card once it's in sight. */
function ShownIn({ places, loose, onShown }: { places: Place[]; loose: string | null; onShown: () => void }) {
  const grids = useGrids((s) => s.grids);
  const go = (p: Place) => goTo(p) && onShown();
  const line = (p: Place, says: string, label: string) => {
    const grid = grids[p.gridId]?.name ?? "a grid";
    return (
      <li key={`${p.content.kind}:${p.gridId}`}>
        <span>
          {says} <span className="strong">{grid}</span>
        </span>
        <button type="button" className="link small" aria-label={`${label} in ${grid}`} onClick={() => go(p)}>
          {label}
        </button>
      </li>
    );
  };
  return (
    <ul className="session-where small" aria-label="Where it is">
      {perGrid(places, false).map((p) => line(p, "In grid", "Go to it"))}
      {perGrid(places, true).map((p) => line(p, "Running in a terminal in", "Go to the terminal"))}
      {loose && (
        <li>
          <span>Running in a Desk terminal that isn’t in a grid</span>
          <button
            type="button"
            className="link small"
            onClick={() => addToGrid({ kind: "terminal", terminalId: loose }, shownGrid(useGrids.getState())?.id ?? null).shown && onShown()}
          >
            Show it
          </button>
        </li>
      )}
    </ul>
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
