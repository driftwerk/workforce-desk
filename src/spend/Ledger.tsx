import { useCallback, useEffect, useState } from "react";
import { ENGINE_TITLE } from "../engines/engines";
import { useSessionNames } from "../groups/names";
import { useDesk } from "../hub/store";
import type { LedgerRow, SpendPeriod, SpendView } from "../hub/types";
import { useHandoff } from "../handoff/store";
import { acrossText } from "../handoff/words";
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

/** How the ledger shows: its calls one by one, or summed by piece of work
 *  (a session and every session it was handed on to, across engines). */
type LedgerShow = "calls" | "work";

/** The ledger's calls, one by one: when, which session, the model, the
 *  tokens and what they cost; by period, and by session. Or by work: one
 *  row for each piece of work, however many engines it went through. */
export function LedgerPanel() {
  const hub = useDesk((s) => s.hub);
  const sessions = useDesk((s) => s.sessions);
  const open = useDesk((s) => s.open);
  const names = useSessionNames();
  const setLedger = useUi((u) => u.setLedger);
  const [period, setPeriod] = useState<LedgerPeriod>("day");
  const [session, setSession] = useState<string>("");
  const [show, setShow] = useState<LedgerShow>("calls");
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
  const calls = (
    <>
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
    </>
  );
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
        <div className="seg" role="radiogroup" aria-label="Show">
          <button type="button" role="radio" aria-checked={show === "calls"} onClick={() => setShow("calls")}>
            Calls
          </button>
          <button type="button" role="radio" aria-checked={show === "work"} onClick={() => setShow("work")}>
            By work
          </button>
        </div>
        {show === "calls" && (
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
        )}
      </div>
      {show === "work" ? <ByWork period={period} /> : calls}
    </SidePanel>
  );
}

/** The ledger summed by work: each piece of work once, named as it goes on
 *  now, with the engines it went through. */
function ByWork({ period }: { period: LedgerPeriod }) {
  const hub = useDesk((s) => s.hub);
  const sessions = useDesk((s) => s.sessions);
  const open = useDesk((s) => s.open);
  const names = useSessionNames();
  const lineage = useHandoff((s) => s.lineage);
  const loadLineage = useHandoff((s) => s.loadLineage);
  const [view, setView] = useState<SpendView | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!hub) return;
    let live = true;
    setView(undefined);
    hub
      .spend(period, "work", 100)
      .then((v) => {
        if (!live) return;
        setView(v);
        setProblem(null);
      })
      .catch((e) => live && setProblem(plainError(e)));
    return () => {
      live = false;
    };
  }, [hub, period]);
  // Which engines each went through: its lineage, read once (no brief).
  const key = (view?.rows ?? []).map((r) => r.session).join(",");
  useEffect(() => {
    for (const id of key.split(",")) if (id && lineage[id] === undefined && sessions[id]) void loadLineage(id);
    // Only when the rows change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (problem)
    return (
      <p className="small state-blocked" role="alert">
        {problem}
      </p>
    );
  if (view === undefined) return <p className="faint small">Loading…</p>;
  if (view === null || view.rows.length === 0)
    return <p className="muted small">No work spent anything {period === "day" ? "today" : period === "week" ? "this week" : "this month"}.</p>;
  const total = view.total.usd;
  return (
    <div className="ledger-days">
      <ol className="spend-rows" aria-label="Spend by work">
        {view.rows.map((r) => {
          const id = r.session;
          const l = id ? lineage[id] : null;
          const engines = [l?.from?.engine, id ? sessions[id]?.engine : null, l?.handedTo?.engine];
          const share = total > 0 ? Math.round((100 * r.totals.usd) / total) : 0;
          return (
            <li key={r.key} className="spend-row" title={breakdownText(r.totals.tokens)}>
              <button type="button" className="spend-name link mono" disabled={!id || !sessions[id]} onClick={() => id && open(id)}>
                {(id && (names[id] ?? sessions[id]?.displayName)) || r.label}
              </button>
              <span className="faint small">{[acrossText(engines), `${tokensText(totalTokens(r.totals.tokens))} tokens`].filter(Boolean).join(" · ")}</span>
              <b className="spend-usd">{usdText(r.totals.usd)}</b>
              <span className="spend-bar" role="img" aria-label={`${share}% of the spend`}>
                <span className="spend-fill" style={{ width: `${share}%` }} />
              </span>
            </li>
          );
        })}
      </ol>
      {view.more > 0 && <p className="faint small">and {view.more} more</p>}
      <p className="faint small">A piece of work handed to another engine is one row: every session it went through, summed.</p>
    </div>
  );
}
