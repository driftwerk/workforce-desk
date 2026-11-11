import { askDesk, useCanAskDesk } from "./askDesk";
import { fullDetailsOf } from "./plainError";
import type { Problem } from "./problem";

/** A problem in the one shape Desk uses everywhere: the headline in plain
 *  words, the button most likely to fix it, and the raw text folded under
 *  Details. `onDone` runs after any button, e.g. to dismiss. */
export function ProblemNote({ problem, onDone, className = "" }: { problem: Problem; onDone?: () => void; className?: string }) {
  const canAsk = useCanAskDesk();
  const { fix } = problem;
  const ask = () => {
    if (askDesk(problem)) onDone?.();
  };
  // With no Desk agent to ask, an ask-fix gives way to its real next step.
  const primary = !fix ? null : fix.ask ? (canAsk ? fix : (fix.alt ?? null)) : fix;
  return (
    <div className={`problem ${className}`.trim()}>
      <p className="problem-plain">{problem.plain}</p>
      {(primary || canAsk || onDone) && (
        <div className="problem-actions">
          {primary && (
            <button
              type="button"
              className="btn btn-sm btn-signal"
              onClick={() => {
                if (primary.ask) ask();
                else {
                  primary.run?.();
                  onDone?.();
                }
              }}
            >
              {primary.label}
            </button>
          )}
          {canAsk && !primary?.ask && (
            <button type="button" className="btn btn-sm" onClick={ask}>
              Ask Desk
            </button>
          )}
          {onDone && (
            <button type="button" className="link small" onClick={onDone}>
              Dismiss
            </button>
          )}
        </div>
      )}
      {problem.details && (
        <details className="problem-details">
          <summary className="small faint">Details</summary>
          <pre className="problem-raw mono small">{problem.details}</pre>
        </details>
      )}
    </div>
  );
}

/** For an inline error string from `plainError`: "Copy details" when the raw
 *  text behind it is longer than what the string shows. */
export function CopyDetails({ text }: { text: string | null | undefined }) {
  const full = text ? fullDetailsOf(text) : null;
  if (!full) return null;
  return (
    <>
      {" "}
      <button type="button" className="link small" onClick={() => void navigator.clipboard?.writeText(full).catch(() => undefined)}>
        Copy details
      </button>
    </>
  );
}
