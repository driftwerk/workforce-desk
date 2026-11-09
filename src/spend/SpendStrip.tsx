import { useEffect } from "react";
import { useHandoff } from "../handoff/store";
import { acrossText } from "../handoff/words";
import { useDesk } from "../hub/store";
import { breakdownText, totalsText, usdText } from "./spend";
import { useSessionSpend, useSpend } from "./store";

/** One line on a session's card: what it spent today, and this week when
 *  that's more; for a piece of work handed across engines, what the whole
 *  work spent this week. */
export function SpendStrip({ sessionId }: { sessionId: string }) {
  const today = useSessionSpend(sessionId, "day");
  const week = useSessionSpend(sessionId, "week");
  if (!today && !week) return <WorkSpend sessionId={sessionId} />;
  const moreThisWeek = week && (!today || week.totals.calls > today.totals.calls);
  return (
    <>
      <p className="spend-strip small" aria-label="Spend" title={breakdownText((today ?? week)!.totals.tokens)}>
        {today && (
          <span>
            <span className="faint">Today </span>
            {totalsText(today.totals)}
          </span>
        )}
        {moreThisWeek && (
          <span>
            <span className="faint">{today ? " · this week " : "This week "}</span>
            {totalsText(week.totals)}
          </span>
        )}
      </p>
      <WorkSpend sessionId={sessionId} />
    </>
  );
}

/** "This work this week: $4.10 across Claude Code and Codex", for a session
 *  whose work was handed on (or to it). */
function WorkSpend({ sessionId }: { sessionId: string }) {
  const lineage = useHandoff((s) => s.lineage[sessionId]);
  const engine = useDesk((s) => s.sessions[sessionId]?.engine);
  const work = useSpend((s) => s.work);
  const loadWork = useSpend((s) => s.loadWork);
  useEffect(() => {
    if (lineage && work === undefined) void loadWork();
  }, [lineage, work, loadWork]);
  if (!lineage || !work) return null;
  const sessions = new Set([...lineage.sessions, sessionId]);
  const row = work.rows.find((r) => r.session && sessions.has(r.session));
  if (!row) return null;
  const engines = [lineage.from?.engine, engine, lineage.handedTo?.engine].filter((e) => !!e);
  return (
    <p className="spend-strip small" aria-label="This work’s spend" title={breakdownText(row.totals.tokens)}>
      <span className="faint">This work this week </span>
      {usdText(row.totals.usd)} {acrossText(engines)}
    </p>
  );
}
