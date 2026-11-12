import { RichMarkdown } from "@workforce/rich";
import { useId, useRef, useState } from "react";
import { usePutInGrid } from "../grids/PutInGrid";
import { LineageChips } from "../handoff/LineageChips";
import { runs } from "./actions";
import { SessionChrome, panelId, tabId, type SessionTab } from "./SessionChrome";
import { useSessionName } from "../groups/names";
import { useDesk, hubFor } from "../hub/store";
import type { Session } from "../hub/types";
import { ShownIn } from "../grids/ShownIn";
import { useGrids } from "../grids/store";
import { placesOf } from "../grids/where";
import { useTerminals } from "../grids/terminals";
import { sessionItem } from "../groups/model";
import { SidePanel, useOutOfSight } from "../panels/Stage";
import { useSeenSession } from "../unread/seen";
import { needsRestartForColors } from "../theme/hubColors";
import { useTheme } from "../theme/store";
import { Approval } from "./Approval";
import { Terminal } from "./Terminal";
import { BreakerBanner } from "../spend/BreakerBanner";
import { SpendStrip } from "../spend/SpendStrip";
import { ImageBudget } from "../shell/RemoteImage";
import { LinePanel } from "../line/LinePanel";
import { ChargeStrip } from "../crew/ChargeBadge";
import { SubjectHistory } from "../board/History";
import { keyOf, machineOf, sessionKey } from "../hub/machines";
import { sessionContent } from "../grids/engine";
import { MemoryPanel } from "../memory/MemoryPanel";

export function SessionCard({ session }: { session: Session }) {
  const { open, sessions } = useDesk();
  const key = sessionKey(session);
  const machine = machineOf(session);
  const name = useSessionName(key, session.name);
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
  const putIn = usePutInGrid(sessionContent(key), () => open(null));
  // The session's own view, what Desk remembers of it, or what it did. The
  // session's stays mounted (its terminal, its seen mark) while another shows.
  const [tab, setTab] = useState<SessionTab>("session");
  const tabIds = useId();
  const shown = places.length > 0 || !!loose;
  return (
    <SidePanel
      className="session-card"
      label={`Session ${name}`}
      noun="this session"
      onClose={() => open(null)}
      chrome={({ focus, close }) => (
        <SessionChrome
          session={session}
          name={name}
          size="panel"
          tab={tab}
          onTab={setTab}
          tabIds={tabIds}
          lead={focus}
          close={close}
          menuLabel="Session options"
          hostEntries={shown ? [] : [{ kind: "item", label: "Put in grid", submenu: putIn }]}
          place={shown && <ShownIn places={places} loose={loose} onShown={() => open(null)} />}
        />
      )}
    >
      {tab === "memory" && (
        <MemoryPanel session={session} name={name} hub={hubFor(session)} id={panelId(tabIds, "memory")} labelledBy={tabId(tabIds, "memory")} />
      )}
      {tab === "history" && (
        <div className="session-history-panel" role="tabpanel" id={panelId(tabIds, "history")} aria-labelledby={tabId(tabIds, "history")}>
          <SubjectHistory subject={session.id} machine={machine} label={`What ${name} did`} />
        </div>
      )}
      {/* The session's own view: hidden, never unmounted, while another tab
          shows (its terminal, its seen mark). What it asks of you stays
          below either. */}
      <div className="session-view" role="tabpanel" id={panelId(tabIds, "session")} aria-labelledby={tabId(tabIds, "session")} hidden={tab !== "session"}>
        <LineageChips session={session} />
        <SpendStrip sessionId={key} />
        <BreakerBanner sessionId={key} />
        <ChargeStrip session={session} />
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
