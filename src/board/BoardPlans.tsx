import { useEffect, useId } from "react";
import { PlanCard } from "../crew/PlanCard";
import { PlanRow } from "../crew/PlanRow";
import type { BossPlan } from "../hub/types";
import { useBoard } from "./store";

/** Whether plan `p` is finished or ended. */
export const over = (p: BossPlan) => p.state === "done" || p.state === "dropped";

/** The boss's plans on a board, under its header: a line for each plan
 *  still going (or, with Finished pressed, each finished or ended one), the
 *  one shown whatever it is, and under the lines the shown plan's whole
 *  card, with everything its card in the boss's DM has. Nothing while the
 *  board has no plans. Finished is the board's (`finished`, set by
 *  `onFinished`), which reads finished plans only while it is pressed. */
export function BoardPlans({
  plans,
  shown,
  finished,
  onFinished,
}: {
  plans: readonly BossPlan[];
  shown: string | null;
  finished: boolean;
  onFinished: (on: boolean) => void;
}) {
  const ids = useId();
  const ended = plans.filter(over).length;
  // None left to show: Finished is off again, for the next one.
  useEffect(() => {
    if (ended === 0) onFinished(false);
  }, [ended, onFinished]);
  const rows = plans.filter((p) => over(p) === finished || p.id === shown);
  if (plans.length === 0) return null;
  const show = useBoard.getState().showPlan;
  const open = rows.find((p) => p.id === shown);
  const card = `${ids}-card`;
  return (
    <section className="board-plans" aria-label="Plans">
      {ended > 0 && (
        <div className="board-plans-filter" role="group" aria-label="Show plans">
          <button type="button" className="chip-btn" aria-pressed={finished} onClick={() => onFinished(!finished)}>
            Finished · {ended}
          </button>
        </div>
      )}
      {rows.map((p) => (
        <PlanRow key={p.id} plan={p} open={p.id === shown} controls={card} onToggle={() => show(p.id === shown ? null : p.id)} />
      ))}
      {open && (
        <div id={card} className="board-plan-card">
          <PlanCard mentioned={{ id: open.id, revision: open.revision }} onBoard />
        </div>
      )}
    </section>
  );
}
