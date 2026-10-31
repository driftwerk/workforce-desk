import { breakdownText, totalsText } from "./spend";
import { useSessionSpend } from "./store";

/** One line on a session's card: what it spent today, and this week when
 *  that's more. */
export function SpendStrip({ sessionId }: { sessionId: string }) {
  const today = useSessionSpend(sessionId, "day");
  const week = useSessionSpend(sessionId, "week");
  if (!today && !week) return null;
  const moreThisWeek = week && (!today || week.totals.calls > today.totals.calls);
  return (
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
  );
}
