import { useState } from "react";
import { useDesk } from "../hub/store";
import { plainError } from "../ui/plainError";
import { heldFor, heldSession } from "./budgets";
import { useBreakers, useBudgets } from "./budgetStore";

/** While Desk's breaker holds a session: why, and Continue (and Keep
 *  paused, while its Floor need is open). Its turn finished; from its next
 *  one its tool calls wait for you. */
export function BreakerBanner({ sessionId, compact = false }: { sessionId: string; compact?: boolean }) {
  const breaker = heldSession(useBreakers(), sessionId);
  const [acting, setActing] = useState<"continue" | "keep" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (!breaker || breaker.level.level !== "held") return null;
  const kept = breaker.level.kept;
  const act = (what: "continue" | "keep") => () => {
    const hub = useDesk.getState().hub;
    if (!hub || acting) return;
    setActing(what);
    setProblem(null);
    (what === "continue" ? hub.breakerContinue(breaker.subject) : hub.breakerKeep(breaker.subject))
      .then(() => useBudgets.getState().load())
      .catch((e: unknown) => setProblem(plainError(e)))
      .finally(() => setActing(null));
  };
  return (
    <div className={`breaker-banner ${compact ? "breaker-banner-compact" : ""}`} role="status" aria-label="Paused by Desk's breaker">
      <span className="dot dot-blocked" aria-hidden="true" />
      <span className="breaker-text">
        <b>Paused · {heldFor(breaker)}</b>
        {!compact && breaker.ask && <span className="small"> {breaker.ask}</span>}
        {!compact && breaker.why && <span className="faint small breaker-why">{breaker.why}</span>}
        {problem && (
          <span className="small state-blocked breaker-why" role="alert">
            {problem}
          </span>
        )}
      </span>
      <span className="breaker-buttons">
        <button type="button" className="btn btn-blocked" disabled={!!acting} onClick={act("continue")}>
          {acting === "continue" ? "Going on…" : "Continue"}
        </button>
        {!kept && !compact && (
          <button type="button" className="btn" disabled={!!acting} onClick={act("keep")}>
            {acting === "keep" ? "Keeping it paused…" : "Keep paused"}
          </button>
        )}
      </span>
    </div>
  );
}
