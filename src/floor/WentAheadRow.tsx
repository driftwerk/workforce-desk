import { useState } from "react";
import { dismissQuestions } from "../line/LinePanel";
import { plainError } from "../ui/plainError";
import type { FloorWentAhead } from "./merge";
import { goToQuestions } from "./NeedRow";
import { FloorRow, useWhoName } from "./Row";
import { dayClock } from "./time";
import { sessionKeyOfItem } from "./needs";

/** A question a session asked you and went ahead without: what it chose,
 *  with Go to session (its pane beside the Floor, questions shown) and
 *  Dismiss. It no longer needs you. */
export function WentAheadRow({ item, now }: { item: FloorWentAhead; now: number }) {
  const name = useWhoName(item);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const here = sessionKeyOfItem(item);
  return (
    <div className="floor-need floor-need-acts floor-went-ahead">
      <FloorRow item={item} look="idle" time={`asked ${dayClock(item.askedAt, now)} · no answer by ${dayClock(item.wentAheadAt, now)}`} tabbed={false}>
        {item.ask}
        {item.chose && <span className="faint"> It chose: {item.chose}</span>}
      </FloorRow>
      {here && (
        <span className="floor-need-buttons">
          <button type="button" className="btn" aria-label={`Go to ${name}`} disabled={item.stale || busy} onClick={() => here && goToQuestions(here)}>
            Go to session
          </button>
          <button
            type="button"
            className="btn"
            aria-label={`Dismiss “${item.ask}” from ${name}`}
            disabled={item.stale || busy}
            onClick={() => {
              setBusy(true);
              setProblem(null);
              dismissQuestions([item.id.slice("line:".length)], item.machine)
                .catch((e: unknown) => setProblem(plainError(e)))
                .finally(() => setBusy(false));
            }}
          >
            Dismiss
          </button>
          {problem && (
            <span className="small state-blocked" role="alert">
              {problem}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
