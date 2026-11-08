import { RichMarkdown } from "@workforce/rich";
import { OnMachine } from "../machines/OnMachine";
import { useId, useRef, useState } from "react";
import { backgroundLine, backgroundOf, lookOf } from "../floor/background";
import { useSessionName } from "../groups/names";
import { useDesk, hubFor } from "../hub/store";
import type { Session } from "../hub/types";
import { PutInGrid } from "../grids/PutInGrid";
import { ShownIn } from "../grids/ShownIn";
import { useGrids } from "../grids/store";
import { placesOf } from "../grids/where";
import { useTerminals } from "../grids/terminals";
import { sessionItem } from "../groups/model";
import { GroupChip } from "../groups/GroupChip";
import { SidePanel, useOutOfSight } from "../panels/Stage";
import { useSeenSession } from "../unread/seen";
import { Mark } from "../ui/Mark";
import { needsRestartForColors } from "../theme/hubColors";
import { useTheme } from "../theme/store";
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
import { keyOf, machineOf, sessionKey } from "../hub/machines";
import { sessionContent } from "../grids/engine";
import { MemoryPanel } from "../memory/MemoryPanel";

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
  const { fail, open, sessions } = useDesk();
  const key = sessionKey(session);
  const machine = machineOf(session);
  const name = useSessionName(key, session.name);
  const actions = sessionActions(session);
  const lifecycle = lifecycleActions(session);
  const order = useGrids((s) => s.order);
  const grids = useGrids((s) => s.grids);
  const places = placesOf({ order, grids }, sessions, sessionItem(key));
  // Running in a Desk terminal that no pane shows (nor the session itself),
  // while the hub has it.
  const ranIn = useTerminals((s) => {
    const t = session.terminalId ? keyOf(machine, session.terminalId) : null;
    return t && s.byId[t]?.live ? t : null;
  });
  const loose = !places.length && session.live ? ranIn : null;
  const [editingGoal, setEditingGoal] = useState(false);
  const [goal, setGoal] = useState(session.goal);
  const [history, setHistory] = useState(false);
  // The session's own view, or what Desk remembers of it. The session's
  // stays mounted (its terminal, its seen mark) while Memory shows.
  const [tab, setTab] = useState<"session" | "memory">("session");
  const tabIds = useId();
  const saveGoal = () => {
    setEditingGoal(false);
    if (goal !== session.goal) hubFor(session)?.update(session.id, { goal }).catch(fail);
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
            <OnMachine machine={machineOf(session)} />
            <GroupChip item={sessionItem(key)} />
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
          {!places.length && !loose && <PutInGrid content={sessionContent(key)} label="Put this session in a grid" onShown={() => open(null)} />}
          {lifecycle.map((a) => (
            <button key={a.label} type="button" className="link" onClick={a.run}>
              {a.label}
            </button>
          ))}
        </>
      }
    >
      <div className="tabs session-tabs" role="tablist" aria-label={`${name}: what shows`}>
        <button
          type="button"
          role="tab"
          id={`${tabIds}-session-tab`}
          aria-selected={tab === "session"}
          aria-controls={`${tabIds}-session`}
          onClick={() => setTab("session")}
        >
          Session
        </button>
        <button
          type="button"
          role="tab"
          id={`${tabIds}-memory-tab`}
          aria-selected={tab === "memory"}
          aria-controls={`${tabIds}-memory`}
          onClick={() => setTab("memory")}
        >
          Memory
        </button>
      </div>
      {tab === "memory" && (
        <MemoryPanel session={session} name={name} hub={hubFor(session)} id={`${tabIds}-memory`} labelledBy={`${tabIds}-memory-tab`} />
      )}
      {/* The session's own view: hidden, never unmounted, while Memory
          shows (its terminal, its seen mark). What it asks of you stays
          below either. */}
      <div className="session-view" role="tabpanel" id={`${tabIds}-session`} aria-labelledby={`${tabIds}-session-tab`} hidden={tab !== "session"}>
      {(places.length > 0 || loose) && <ShownIn places={places} loose={loose} onShown={() => open(null)} />}
      <div className="session-goal">
        <SessionTicketChip session={key} />
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
          <button type="button" className="link small session-line-history" onClick={() => useLinePanel.getState().show(key, "history")}>
            Messages with Desk…
          </button>
        )}
        <button type="button" className="link small session-line-history" aria-expanded={history} onClick={() => setHistory((h) => !h)}>
          {history ? "Hide history" : "History"}
        </button>
      </div>
      {history && <SubjectHistory subject={session.id} machine={machine} label={`What ${name} did`} />}
      <SpendStrip sessionId={key} />
      <BreakerBanner sessionId={key} />
      <ChargeStrip session={session} />
      {approvalsSwitchable(session) && (
        <label className="session-approvals small">
          <input type="checkbox" checked={session.approvals === "desk"} onChange={(e) => setApprovalsInDesk(session, e.target.checked)} />
          Answer approvals in Desk
          <span className="faint"> · else its terminal asks</span>
        </label>
      )}
      <SessionBody session={session} />
      </div>
      <Approval session={session} />
      <LinePanel session={session} />
    </SidePanel>
  );
}

/** Shown while a running session's CLI draws for the other ground than its
 *  terminal's now (it read the colours at its start): restarting it, which
 *  resumes its conversation, gives it the new ones. */
function RestartForColors({ session }: { session: Session }) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  // A turn under way stops with it: asked first.
  const [asking, setAsking] = useState(false);
  if (!needsRestartForColors(session, theme)) return null;
  const restart = () => {
    setAsking(false);
    setBusy(true);
    hubFor(session)
      ?.restart(session.id)
      .catch(useDesk.getState().fail)
      .finally(() => setBusy(false));
  };
  const working = session.state === "working";
  return (
    <div className="session-recolor small" role="status">
      {asking ? (
        <>
          <span className="muted">It is working: restarting stops this turn, and the conversation resumes.</span>
          <button type="button" className="link" onClick={restart}>
            Restart now
          </button>
          <button type="button" className="link" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <span className="muted">Drawn for a {session.fixedGround} terminal; it takes the new colours when it restarts.</span>
          <button type="button" className="link" disabled={busy} onClick={working ? () => setAsking(true) : restart}>
            {busy ? "Restarting…" : "Restart to apply"}
          </button>
        </>
      )}
    </div>
  );
}

/** What a session shows: its terminal while it runs (the Desk terminal it
 *  was started in, for a tracked one), else why it isn't running and the
 *  last thing it said. */
export function SessionBody({ session, autoFocus = true }: { session: Session; autoFocus?: boolean }) {
  // It's read while the card or pane it is in is on screen: the element
  // around it, whether it runs or not.
  const host = useRef<HTMLElement | null>(null);
  useSeenSession(sessionKey(session), host, { enabled: !useOutOfSight() });
  // What's on screen is the nearest holder that draws a box: the session's
  // own view lays out as `display: contents`, which is never on screen.
  const seen = <span hidden ref={(el) => void (host.current = boxOf(el?.parentElement ?? null))} />;
  return session.live ? (
    <>
      {seen}
      <RestartForColors session={session} />
      {session.terminalId ? (
        <Terminal key={session.terminalId} terminalId={session.terminalId} machine={machineOf(session)} autoFocus={autoFocus} />
      ) : (
        <Terminal key={session.id} sessionId={session.id} machine={machineOf(session)} autoFocus={autoFocus} />
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

/** `el`, or its nearest ancestor that draws a box of its own: an element
 *  laid out as `display: contents` has none, so it is never seen on screen. */
export function boxOf(el: HTMLElement | null): HTMLElement | null {
  let at = el;
  while (at && getComputedStyle(at).display === "contents") at = at.parentElement;
  return at;
}
