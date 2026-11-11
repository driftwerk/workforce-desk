import { askDesk, useCanAskDesk } from "./askDesk";
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
  const primary = fix && (fix.ask ? canAsk : true) ? fix : null;
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
