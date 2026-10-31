import { useEffect, useState } from "react";
import { ENGINE_TITLE } from "../engines/engines";
import { useDesk } from "../hub/store";
import type { SpendRow } from "../hub/types";
import { breakdownText, tokensText, totalTokens, totalsText, unpricedText, usdText } from "./spend";
import { useSpend, type FloorPeriod } from "./store";

/** Sessions the card lists at most. */
const TOP = 5;

const PERIOD: Record<FloorPeriod, string> = { day: "Today", week: "This week" };

/** The sessions that spent most today or this week, from the hub's ledger:
 *  tokens and API-equivalent dollars; a row opens its session. */
export function SpendCard() {
  const hub = useDesk((s) => s.hub);
  const load = useSpend((s) => s.load);
  const supported = useSpend((s) => s.supported);
  const failed = useSpend((s) => s.failed);
  const [period, setPeriod] = useState<FloorPeriod>("day");
  const view = useSpend((s) => s.views[period]);
  useEffect(() => {
    if (hub) void load();
  }, [hub, load]);
  if (supported === false || (!view && !failed)) return null;
  const rows = view?.rows.slice(0, TOP) ?? [];
  const unpriced = view && unpricedText(view.total);
  return (
    <section className="floor-card spend-card" aria-label="Spend">
      <div className="floor-card-head">
        <h2 className="display floor-card-title">Spend</h2>
        <div className="seg" role="radiogroup" aria-label="Period">
          {(Object.keys(PERIOD) as FloorPeriod[]).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={period === p} onClick={() => setPeriod(p)}>
              {PERIOD[p]}
            </button>
          ))}
        </div>
      </div>
      {failed && !view ? (
        <p className="muted small">Couldn’t read the ledger just now.</p>
      ) : !view || rows.length === 0 ? (
        <p className="muted small">No session has spent anything {period === "day" ? "today" : "this week"}.</p>
      ) : (
        <>
          <p className="small">{totalsText(view.total)}</p>
          <ol className="spend-rows">
            {rows.map((r) => (
              <Row key={r.key} row={r} total={view.total.usd} />
            ))}
          </ol>
          {view.rows.length > TOP && <p className="faint small">and {view.rows.length - TOP + view.more} more</p>}
          {unpriced && <p className="faint small">{unpriced}</p>}
          <p className="faint small">What the tokens would cost at API prices; a session on a plan pays its plan.</p>
        </>
      )}
    </section>
  );
}

function Row({ row, total }: { row: SpendRow; total: number }) {
  const open = useDesk((s) => s.open);
  const share = total > 0 ? Math.round((100 * row.totals.usd) / total) : 0;
  const what = [row.engine && ENGINE_TITLE[row.engine], `${tokensText(totalTokens(row.totals.tokens))} tokens`].filter(Boolean).join(" · ");
  return (
    <li className="spend-row">
      <button
        type="button"
        className="spend-name link"
        disabled={!row.session}
        onClick={() => row.session && open(row.session)}
        title={breakdownText(row.totals.tokens)}
      >
        {row.label}
      </button>
      <span className="faint small">{what}</span>
      <b className="spend-usd">{usdText(row.totals.usd)}</b>
      <span className="spend-bar" role="img" aria-label={`${share}% of the spend`}>
        <span className="spend-fill" style={{ width: `${share}%` }} />
      </span>
    </li>
  );
}
