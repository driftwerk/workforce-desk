import { RichMarkdown } from "@workforce/rich";
import { useRef, useState } from "react";
import { backgroundLine, backgroundOf, lookOf } from "../floor/background";
import { useSessionName } from "../groups/names";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { PutInGrid } from "../grids/PutInGrid";
import { ShownIn } from "../grids/ShownIn";
import { useGrids } from "../grids/store";
import { placesOf } from "../grids/where";
import { useTerminals } from "../grids/terminals";
import { sessionItem } from "../groups/model";
import { SidePanel, useOutOfSight } from "../panels/Stage";
import { useSeenSession } from "../unread/seen";
import { Mark } from "../ui/Mark";
import { approvalsSwitchable, lifecycleActions, runs, sessionActions, setApprovalsInDesk } from "./actions";
import { Approval } from "./Approval";
import { Terminal } from "./Terminal";
import { homeShort } from "../ui/paths";
import { switchingText, withAccount } from "../engines/accounts";
import { ENGINE_TITLE } from "../engines/engines";
import { BreakerBanner } from "../spend/BreakerBanner";
import { SpendStrip } from "../spend/SpendStrip";
import { ImageBudget } from "../shell/RemoteImage";
import { LinePanel } from "../line/LinePanel";
import { useLinePanel } from "../line/panel";
import { ChargeStrip } from "../crew/ChargeBadge";
import { SessionTicketChip } from "../board/TicketChip";
import { SubjectHistory } from "../board/History";

const ENGINE = ENGINE_TITLE;

const where = (s: Session): string => {
  const background = backgroundOf(s);
  return [
    withAccount(ENGINE[s.engine], s),
    switchingText(s),
    s.approveForMe && "Approve for me",
    s.branch ? `branch ${s.branch}` : homeShort(s.cwd),
    background && backgroundLine(background),
  ]
    .filter(Boolean)
    .join(" · ");
};

export function SessionCard({ session }: { session: Session }) {
  const { hub, fail, open, sessions } = useDesk();
  const name = useSessionName(session.id, session.name);
  const actions = sessionActions(session);
  const lifecycle = lifecycleActions(session);
  const order = useGrids((s) => s.order);
  const grids = useGrids((s) => s.grids);
  const places = placesOf({ order, grids }, sessions, sessionItem(session.id));
  // Running in a Desk terminal that no pane shows (nor the session itself),
  // while the hub has it.
  const ranIn = useTerminals((s) => (session.terminalId && s.byId[session.terminalId]?.live ? session.terminalId : null));
  const loose = !places.length && session.live ? ranIn : null;
  const [editingGoal, setEditingGoal] = useState(false);
  const [goal, setGoal] = useState(session.goal);
  const [history, setHistory] = useState(false);
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
          {actions.map((a) => (
            <button key={a.label} type="button" className="link" onClick={a.run}>
              {a.label}
            </button>
          ))}
          {!places.length && !loose && <PutInGrid content={{ kind: "session", sessionId: session.id }} label="Put this session in a grid" onShown={() => open(null)} />}
          {lifecycle.map((a) => (
            <button key={a.label} type="button" className="link" onClick={a.run}>
              {a.label}
            </button>
          ))}
        </>
      }
    >
      {(places.length > 0 || loose) && <ShownIn places={places} loose={loose} onShown={() => open(null)} />}
      <div className="session-goal">
        <SessionTicketChip session={session.id} />
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
        {session.view !== "desk" && (
          <button type="button" className="link small session-line-history" onClick={() => useLinePanel.getState().show(session.id, "history")}>
            Messages with Desk…
          </button>
        )}
        <button type="button" className="link small session-line-history" aria-expanded={history} onClick={() => setHistory((h) => !h)}>
          {history ? "Hide history" : "History"}
        </button>
      </div>
      {history && <SubjectHistory subject={session.id} label={`What ${name} did`} />}
      <SpendStrip sessionId={session.id} />
      <BreakerBanner sessionId={session.id} />
      <ChargeStrip session={session} />
      {approvalsSwitchable(session) && (
        <label className="session-approvals small">
          <input type="checkbox" checked={session.approvals === "desk"} onChange={(e) => setApprovalsInDesk(session, e.target.checked)} />
          Answer approvals in Desk
          <span className="faint"> · else its terminal asks</span>
        </label>
      )}
      <SessionBody session={session} />
      <Approval session={session} />
      <LinePanel session={session} />
    </SidePanel>
  );
}

/** What a session shows: its terminal while it runs (the Desk terminal it
 *  was started in, for a tracked one), else why it isn't running and the
 *  last thing it said. */
export function SessionBody({ session, autoFocus = true }: { session: Session; autoFocus?: boolean }) {
  // It's read while the card or pane it is in is on screen: the element
  // around it, whether it runs or not.
  const host = useRef<HTMLElement | null>(null);
  useSeenSession(session.id, host, { enabled: !useOutOfSight() });
  const seen = <span hidden ref={(el) => void (host.current = el?.parentElement ?? null)} />;
  return session.live ? (
    <>
      {seen}
      {session.terminalId ? (
        <Terminal key={session.terminalId} terminalId={session.terminalId} autoFocus={autoFocus} />
      ) : (
        <Terminal key={session.id} sessionId={session.id} autoFocus={autoFocus} />
      )}
    </>
  ) : (
    <>
      {seen}
      <div className="terminal-idle">
        <p className="muted">
          {runs(session)
            ? "Running in another terminal. Desk shows its progress; once it's closed you can resume it here."
            : session.state === "interrupted"
              ? "This session was working when it stopped. Resume picks up the same conversation."
              : session.origin === "external"
                ? "Closed in its own terminal. Resume in Desk picks up the same conversation here."
                : "Not running. Resume picks up the same conversation."}
        </p>
        {session.lastReply && (
          <div className="transcript-tail rich">
            <ImageBudget>
              <RichMarkdown text={session.lastReply} />
            </ImageBudget>
          </div>
        )}
      </div>
    </>
  );
}
