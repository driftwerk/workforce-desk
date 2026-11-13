import { useEffect, useState } from "react";
import { useDesk } from "../hub/store";
import type { FullBudget, SpendView } from "../hub/types";
import { usdText } from "../spend/spend";
import { MAX_FULL_BUDGET_USD, type Oversight } from "./oversight";

type Change = (o: Oversight) => Oversight;

/** Why the level chosen isn't the one it runs at, one cause at a time. */
export type Cause =
  | { kind: "spent"; spentUsd: number; budgetUsd: number }
  | { kind: "unread" };

/** What a day's spend by account says the hub has counted: metered calls
 *  (an API key, a cloud account), or every call where only that reaches
 *  the budget (an older hub counts plans' calls at API prices too). */
export const spentToday = (
  day: SpendView | null,
): { metered: number; all: number } => {
  const rows = day?.rows ?? [];
  const metered = rows
    .filter(
      (r) =>
        r.totals.billing.length > 0 &&
        r.totals.billing.every((b) => b === "key" || b === "vendor"),
    )
    .reduce((sum, r) => sum + r.totals.usd, 0);
  return { metered, all: day?.total.usd ?? 0 };
};

/** Why `o`, chosen at Act fully, isn't in force: when the hub says it
 *  runs below what was chosen, or today's spend is over its budget (Act
 *  fully needs no repos or switches). `budget`: the hub's own
 *  count of the real money spent against it, which a newer hub gives and
 *  which wins over what Desk reckons from the ledger. Null while it's in
 *  force. */
export const causeOf = (
  o: Oversight,
  held: boolean,
  day: SpendView | null,
  budget?: FullBudget | null,
): Cause | null => {
  if (o.level !== "full") return null;
  if (budget?.spent && budget.spentUsd !== null)
    return { kind: "spent", spentUsd: budget.spentUsd, budgetUsd: budget.budgetUsd };
  if (!held) return null;
  if (budget) return { kind: "unread" };
  const budgetUsd = o.full.budgetUsdPerDay;
  if (budgetUsd === null) return { kind: "unread" };
  const { metered, all } = spentToday(day);
  const spent = metered >= budgetUsd ? metered : all >= budgetUsd ? all : null;
  return spent === null
    ? { kind: "unread" }
    : { kind: "spent", spentUsd: spent, budgetUsd };
};

/** A budget that leaves room for today: half again what it spent, in steps
 *  of $5, and above what it was. */
export const raisedBudget = (spentUsd: number, budgetUsd: number): number =>
  Math.min(
    MAX_FULL_BUDGET_USD,
    Math.max(budgetUsd + 5, Math.ceil((spentUsd * 1.5) / 5) * 5),
  );

/** The cause the level chosen isn't in force, with what fixes it in place:
 *  a higher budget or today's count cleared once it's spent. `held`: the hub
 *  says it runs below what was chosen; `budget`: its count of real money. */
export function WhyNotInForce({
  o,
  held,
  budget,
  onChange,
}: {
  o: Oversight;
  held: boolean;
  budget?: FullBudget | null;
  onChange: (change: Change) => void;
}) {
  const hub = useDesk((s) => s.hub);
  const [day, setDay] = useState<SpendView | null>(null);
  const wantsSpend = o.level === "full" && held && !budget;
  useEffect(() => {
    if (!hub || !wantsSpend) return;
    let live = true;
    hub
      .spend("day", "account", 50)
      .then((v) => live && setDay(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [hub, wantsSpend]);
  const cause = causeOf(o, held, day, budget);
  if (!cause) return null;

  const raised =
    cause.kind === "spent"
      ? raisedBudget(cause.spentUsd, cause.budgetUsd)
      : null;

  return (
    <div className="oversee-why" role={cause.kind === "spent" ? "alert" : "status"}>
      {cause.kind === "spent" && (
        <>
          <p className="small">
            <b className="state-blocked">Act fully stopped: today’s budget is spent.</b>{" "}
            {usdText(cause.spentUsd)} of {usdText(cause.budgetUsd)} in real money today
            {budget ? " (your plans aren’t counted)" : ""}, so it no longer merges,
            tags, releases or runs workflows on its own. It acts as Act until
            midnight, unless you raise the budget or clear today’s count.
          </p>
          {budget && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                onChange((x) => ({
                  ...x,
                  full: { ...x.full, budgetClearedAt: new Date().toISOString() },
                }))
              }
            >
              Clear today’s count
            </button>
          )}
          {raised !== null && raised > cause.budgetUsd ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                onChange((x) => ({
                  ...x,
                  full: { ...x.full, budgetUsdPerDay: raised },
                }))
              }
            >
              Raise to {usdText(raised)} a day
            </button>
          ) : (
            <p className="small faint">
              It’s at the most a daily budget can be.
            </p>
          )}
        </>
      )}
      {cause.kind === "unread" && (
        <p className="small faint">
          Acting as Act until the hub has read today’s spend. It checks again in
          a moment.
        </p>
      )}
    </div>
  );
}
