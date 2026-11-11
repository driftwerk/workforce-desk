import { useEffect, useState } from "react";
import { useDesk } from "../hub/store";
import type { FullBudget, SpendView } from "../hub/types";
import { usdText } from "../spend/spend";
import {
  fullMissing,
  isUnbound,
  MAX_FULL_BUDGET_USD,
  parseBudget,
  type Oversight,
} from "./oversight";
import { presetOf, withPreset } from "./presets";
import { suggestFull } from "./suggest";

type Change = (o: Oversight) => Oversight;

/** Why the level chosen isn't the one it runs at, one cause at a time. */
export type Cause =
  | { kind: "needs"; missing: ("repos" | "budget")[] }
  | { kind: "switches" }
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

/** Why `o`, chosen at Act fully or Unbound, isn't in force: what's missing
 *  from it, its switches, or, when the hub says it runs below what was
 *  chosen, today's spend against its budget. `budget`: the hub's own
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
  const missing = fullMissing(o);
  if (missing.length > 0) return { kind: "needs", missing };
  if (o.full.anywhere && !isUnbound(o) && presetOf(o) === null)
    return { kind: "switches" };
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

const needsText = (missing: ("repos" | "budget")[]): string =>
  missing.length === 2
    ? "repos to work in and a daily budget"
    : missing[0] === "repos"
      ? "a repo to work in"
      : "a daily budget";

/** The cause the level chosen isn't in force, with what fixes it in place:
 *  Desk's suggestions for what's missing, every switch on for Unbound, a
 *  higher budget or today's count cleared once it's spent. `held`: the hub
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
  const sessions = useDesk((s) => s.sessions);
  const [day, setDay] = useState<SpendView | null>(null);
  const [finding, setFinding] = useState<"idle" | "finding" | "none">("idle");
  /** What Desk found, shown to say yes to before anything is written. */
  const [found, setFound] = useState<{
    repos: string[];
    workflows: string[];
    budgetUsd: number | null;
  } | null>(null);
  const wantsSpend = o.level === "full" && held && !budget && fullMissing(o).length === 0;
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

  /** Finds what's missing, to show; nothing is written until confirmed. */
  const suggest = async () => {
    if (!hub) return;
    setFinding("finding");
    const s = await suggestFull(hub, Object.values(sessions)).catch(() => null);
    const repos = o.full.repos.length ? [] : (s?.repos ?? []);
    const workflows = o.full.workflows.length ? [] : (s?.workflows ?? []);
    const budget =
      o.full.budgetUsdPerDay === null && s
        ? parseBudget(String(s.budgetUsd))
        : null;
    const budgetUsd = budget && "value" in budget ? budget.value : null;
    if (repos.length + workflows.length === 0 && budgetUsd === null)
      return setFinding("none");
    setFinding(
      fullMissing(o).includes("repos") && repos.length === 0 ? "none" : "idle",
    );
    setFound({ repos, workflows, budgetUsd });
  };
  const confirm = () => {
    if (!found) return;
    setFound(null);
    onChange((x) => ({
      ...x,
      full: {
        ...x.full,
        repos: x.full.repos.length ? x.full.repos : found.repos,
        workflows: x.full.workflows.length ? x.full.workflows : found.workflows,
        budgetUsdPerDay: x.full.budgetUsdPerDay ?? found.budgetUsd,
      },
    }));
  };
  const raised =
    cause.kind === "spent"
      ? raisedBudget(cause.spentUsd, cause.budgetUsd)
      : null;

  return (
    <div className="oversee-why" role={cause.kind === "spent" ? "alert" : "status"}>
      {cause.kind === "needs" && (
        <>
          <p className="small state-blocked">
            Acting as Act: Act fully needs {needsText(cause.missing)}.
          </p>
          {!found && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={finding === "finding"}
              onClick={() => void suggest()}
            >
              {finding === "finding" ? "Looking…" : "See Desk’s suggestions"}
            </button>
          )}
          {finding === "none" && (
            <p className="small faint">
              Desk found no repos in your sessions’ folders. Add one below.
            </p>
          )}
          {found && (
            <div
              className="oversee-found"
              role="group"
              aria-label="Desk’s suggestions"
            >
              <ul className="small">
                {found.repos.length > 0 && (
                  <li>Repos: {found.repos.join(", ")}</li>
                )}
                {found.workflows.length > 0 && (
                  <li>Workflows: {found.workflows.join(", ")}</li>
                )}
                {found.budgetUsd !== null && (
                  <li>Daily budget: {usdText(found.budgetUsd)}</li>
                )}
              </ul>
              <button
                type="button"
                className="btn btn-sm btn-signal"
                onClick={confirm}
              >
                Add these
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setFound(null)}
              >
                Cancel
              </button>
            </div>
          )}
        </>
      )}
      {cause.kind === "switches" && (
        <>
          <p className="small state-blocked">
            Unbound needs every switch on, so it acts as Act fully for now.
          </p>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onChange((x) => withPreset(x, "unbound"))}
          >
            Turn every switch on
          </button>
        </>
      )}
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
