import { useId } from "react";
import { PlanCard } from "../crew/PlanCard";
import { PlanRow } from "../crew/PlanRow";
import type { BossPlan } from "../hub/types";
import { useBoard } from "./store";

/** The boss's plans on a board, under its header: a line for each plan
 *  that isn't done (and the one shown, done or not), and under the lines
 *  the shown plan's whole card, with everything its card in the boss's DM
 *  has. Nothing while the board has no plans. */
export function BoardPlans({ plans, shown }: { plans: readonly BossPlan[]; shown: string | null }) {
  const ids = useId();
  const rows = plans.filter((p) => p.state !== "done" || p.id === shown);
  if (rows.length === 0) return null;
  const show = useBoard.getState().showPlan;
  const open = rows.find((p) => p.id === shown);
  const card = `${ids}-card`;
  return (
    <section className="board-plans" aria-label="Plans">
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
