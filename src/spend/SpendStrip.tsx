import { useEffect, useState } from "react";
import type { SpendTotals } from "../hub/types";
import { Popover } from "../ui/Popover";
import { useHandoff } from "../handoff/store";
import { acrossText } from "../handoff/words";
import { useDesk } from "../hub/store";
import { breakdownText, tokensText, totalTokens, usdMeans, usdText } from "./spend";
import { useSessionSpend, useSpend } from "./store";

/** What a session spent, in its chrome: today's dollars on a chip (or this
 *  week's, when it spent nothing today), opening today and this week in
 *  tokens and dollars, what the dollars are, and what the whole work spent
 *  when it was handed across engines. The token split is its tooltip. */
export function CostChip({ sessionId }: { sessionId: string }) {
  const today = useSessionSpend(sessionId, "day");
  const week = useSessionSpend(sessionId, "week");
  const [from, setFrom] = useState<HTMLElement | null>(null);
  const shown = today ?? week;
  if (!shown) return null;
  const usd = shown.totals.usd;
  return (
    <>
      <button
        type="button"
        className="sc-cost"
        aria-haspopup="dialog"
        aria-expanded={!!from}
        aria-label={`Spend ${today ? "today" : "this week"}: ${usdText(usd)} ${usdMeans(shown.totals)}`}
        title={breakdownText(shown.totals.tokens)}
        onClick={(e) => setFrom(from ? null : e.currentTarget)}
      >
        <span className="sc-long">{usdText(usd)}</span>
        <span className="sc-short">{usd >= 1 ? `$${Math.round(usd)}` : usdText(usd)}</span>
      </button>
      {from && (
        <Popover label="What it spent" from={from} onClose={() => setFrom(null)} className="cost-pop">
          <p className="cost-pop-title">Spend</p>
          <dl className="cost-pop-rows" title={breakdownText(shown.totals.tokens)}>
            {today && (
              <>
                <dt>Today</dt>
                <dd>
                  {tokensText(totalTokens(today.totals.tokens))} tokens · <b>{usdText(today.totals.usd)}</b>
                </dd>
              </>
            )}
            {week && (
              <>
                <dt>This week</dt>
                <dd>
                  {tokensText(totalTokens(week.totals.tokens))} tokens · <b>{usdText(week.totals.usd)}</b>
                </dd>
              </>
            )}
          </dl>
          <p className="small faint">{meansText(shown.totals)}</p>
          <WorkSpend sessionId={sessionId} />
        </Popover>
      )}
    </>
  );
}

/** What the dollars are, in a sentence. */
const meansText = (t: SpendTotals): string =>
  usdMeans(t) === "API-equivalent" ? "API-equivalent: what these calls would cost at API prices. They run on your plan." : "Billed to your API key.";

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
