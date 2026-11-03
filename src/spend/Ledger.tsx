import { useCallback, useEffect, useState } from "react";
import { ENGINE_TITLE } from "../engines/engines";
import { useSessionNames } from "../groups/names";
import { useDesk } from "../hub/store";
import type { LedgerRow, SpendPeriod } from "../hub/types";
import { SidePanel } from "../panels/Stage";
import { useUi } from "../shell/ui";
import { plainError } from "../ui/plainError";
import { breakdownText, tokensText, totalTokens, usdText } from "./spend";

const PERIODS: Record<Extract<SpendPeriod, "day" | "week" | "month">, string> = { day: "Today", week: "This week", month: "This month" };
type LedgerPeriod = keyof typeof PERIODS;

const BILLED: Record<LedgerRow["billing"], string> = { plan: "plan", key: "API key", vendor: "vendor's", unknown: "" };

/** "Tue 3 Nov". */
const dayOf = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const clockOf = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** `rows` under the day each was in, newest first. */
export const byDay = (rows: readonly LedgerRow[]): { day: string; rows: LedgerRow[] }[] =>
  rows.reduce<{ day: string; rows: LedgerRow[] }[]>((days, r) => {
    const day = dayOf(r.at);
    const last = days[days.length - 1];
    if (last?.day === day) last.rows.push(r);
    else days.push({ day, rows: [r] });
    return days;
  }, []);

/** The ledger's calls, one by one: when, which session, the model, the
 *  tokens and what they cost; by period, and by session. */
export function LedgerPanel() {
  const hub = useDesk((s) => s.hub);
  const sessions = useDesk((s) => s.sessions);
  const open = useDesk((s) => s.open);
  const names = useSessionNames();
  const setLedger = useUi((u) => u.setLedger);
  const [period, setPeriod] = useState<LedgerPeriod>("day");
  const [session, setSession] = useState<string>("");
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(
    async (before?: string) => {
      if (!hub) return;
      try {
        const page = await hub.ledger({ period, session: session || undefined, before });
        setRows((was) => (before ? [...(was ?? []), ...page.rows] : page.rows));
        setNext(page.next);
        setProblem(null);
      } catch (e) {
        setProblem(plainError(e));
      }
    },
    [hub, period, session],
  );
  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);
  const nameOf = (id: string) => names[id] ?? sessions[id]?.displayName ?? sessions[id]?.name ?? "A session since forgotten";
  const seen = [...new Set((rows ?? []).map((r) => r.session))];
  return (
    <SidePanel className="ledger-panel" label="Ledger" noun="the ledger" onClose={() => setLedger(false)} title={<b className="display rpanel-name">Ledger</b>}>
      <div className="ledger-filters">
        <div className="seg" role="radiogroup" aria-label="Period">
          {(Object.keys(PERIODS) as LedgerPeriod[]).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={period === p} onClick={() => setPeriod(p)}>
              {PERIODS[p]}
            </button>
          ))}
        </div>
        <label className="small ledger-session">
          <span className="sr-only">Session</span>
          <select value={session} onChange={(e) => setSession(e.target.value)} aria-label="Session">
            <option value="">Every session</option>
            {[...new Set([...seen, ...(session ? [session] : [])])].map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
      {rows === null && !problem ? (
        <p className="faint small">Loading…</p>
      ) : rows && rows.length === 0 ? (
        <p className="muted small">No calls {period === "day" ? "today" : period === "week" ? "this week" : "this month"}.</p>
      ) : (
        <div className="ledger-days">
          {byDay(rows ?? []).map((d) => (
            <section key={d.day} aria-label={d.day}>
              <h3 className="field-label">{d.day}</h3>
              <ol className="ledger-rows">
                {d.rows.map((r) => (
                  <li key={`${r.engine}:${r.key}`} className="ledger-row" title={breakdownText(r.tokens)}>
                    <span className="faint small ledger-at">{clockOf(r.at)}</span>
                    <button type="button" className="link ledger-name mono" disabled={!sessions[r.session]} onClick={() => open(r.session)}>
                      {nameOf(r.session)}
                    </button>
                    <b className="ledger-usd">{r.usd === null ? <span className="faint">no price</span> : usdText(r.usd)}</b>
                    <span className="faint small ledger-what">
                      {[ENGINE_TITLE[r.engine], r.model, `${tokensText(totalTokens(r.tokens))} tokens`, BILLED[r.billing]].filter(Boolean).join(" · ")}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ))}
          {next && (
            <button type="button" className="btn" onClick={() => void load(next)}>
              Show older
            </button>
          )}
          <p className="faint small">Dollars at API prices: what a key pays, and what a plan's calls are worth.</p>
        </div>
      )}
    </SidePanel>
  );
}
