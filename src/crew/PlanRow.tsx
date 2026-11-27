import { useId, useMemo, useState } from "react";
import { useBoard } from "../board/store";
import { MoreIcon, below } from "../groups/rows";
import { useDesk } from "../hub/store";
import type { BossPlan } from "../hub/types";
import { Confirm } from "../ui/Confirm";
import { Menu } from "../ui/Menu";
import { plainError } from "../ui/plainError";
import { liveTickets, pausedWhy, progress, resumable, ruled, segments, standing } from "./plan";
import { usePlans } from "./planStore";

/** Opens plan `p` on its board, in Desk's main area: its card above the
 *  columns, its tickets alone in them. (Never in a grid's pane, whose board
 *  has no header to show the plan in.) */
export const openPlanOnBoard = (p: Pick<BossPlan, "id" | "board">): void => {
  const board = useBoard.getState();
  board.show(p.board);
  board.showPlan(p.id);
  useDesk.getState().setView("board");
};

/** A plan in a line: its goal, where it stands, how far it has got,
 *  Pause or Resume, and its menu (End plan, or Remove once over). With `open`, its goal opens and closes its whole card
 *  (the board's); without, Open on board does `onToggle` (Settings). */
export function PlanRow({ plan, open, onToggle, controls }: { plan: BossPlan; open?: boolean; onToggle: () => void; controls?: string }) {
  const detail = usePlans((s) => s.details[plan.id]);
  const refusal = usePlans((s) => s.refusals[plan.id]);
  const board = useBoard((s) => s.tickets);
  const [asking, setAsking] = useState<"pause" | "resume" | "remove" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const said = useId();
  // As its card counts it: the board's tickets as they now are, else what
  // the hub last said of it.
  const now = useMemo(() => (detail ? progress(liveTickets(detail, board).map(ruled)) : plan.progress), [detail, board, plan.progress]);
  const stand = standing(plan);
  const paused = plan.state === "paused" && plan.paused ? pausedWhy(plan) : null;
  const line = [`${now.done} of ${now.total} done`, now.doing > 0 ? `${now.doing} running` : null].filter(Boolean).join(" · ");

  const run = async (what: "pause" | "resume" | "remove") => {
    if (asking) return;
    setAsking(what);
    setProblem(null);
    const store = usePlans.getState();
    try {
      await (what === "pause" ? store.pause(plan.id) : what === "resume" ? store.resume(plan.id) : store.remove(plan.id));
    } catch (e) {
      // A refusal the store explains is shown from there.
      if (!usePlans.getState().refusals[plan.id]) setProblem(plainError(e));
    } finally {
      setAsking(null);
    }
  };
  const busy = asking !== null;
  // The open card says the hub's refusal itself.
  const told = (open ? null : refusal?.text) ?? problem;
  return (
    <div className={open ? "plan-row plan-row-open" : "plan-row"} role="group" aria-label={`Plan: ${plan.goal}`} aria-describedby={told ? said : undefined}>
      {open === undefined ? (
        <span className="plan-row-goal">{plan.goal}</span>
      ) : (
        <button
          type="button"
          className="plan-row-toggle"
          aria-expanded={open}
          aria-controls={open ? controls : undefined}
          title={open ? "Hide the plan" : "Show the whole plan"}
          onClick={onToggle}
        >
          <span className={`grp-chevron ${open ? "open" : ""}`} aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 2l4 3-4 3" />
            </svg>
          </span>
          <span className="plan-row-goal">{plan.goal}</span>
        </button>
      )}
      <span className={`chip pc-chip-${stand.look}`} title={paused ? `Paused: ${paused}` : undefined}>
        {stand.text}
      </span>
      <span className="pc-segbar plan-row-bar" role="img" title={line} aria-label={segments(now).map((s) => `${s.n} ${s.kind}`).join(", ") || "nothing yet"}>
        {segments(now).map((s) => (
          <i key={s.kind} className={`pc-s-${s.kind}`} style={{ flex: s.n }} />
        ))}
      </span>
      <span className="muted small plan-row-line">{line}</span>
      {open === undefined && (
        <button type="button" className="link small plan-row-board" onClick={onToggle}>
          Open on board
        </button>
      )}
      {/* Kept as wide with no button, so each line's count lines up. */}
      <span className="plan-row-act">
        {plan.state === "running" && (
          <button type="button" className="btn btn-sm" aria-disabled={busy || undefined} onClick={() => void run("pause")}>
            {asking === "pause" ? "Pausing…" : "Pause"}
          </button>
        )}
        {plan.state === "paused" && resumable(plan.paused) && (
          <button type="button" className="btn btn-sm" aria-disabled={busy || undefined} onClick={() => void run("resume")}>
            {asking === "resume" ? "Resuming…" : "Resume"}
          </button>
        )}
      </span>
      <PlanRowMenu plan={plan} busy={busy} onRemove={() => void run("remove")} />
      {told && (
        <span id={said} className="small state-blocked plan-row-said" role="alert">
          {told}
        </span>
      )}
    </div>
  );
}

/** A plan line's ⋯: End plan (asked first) while it runs or is paused,
 *  Remove once it is finished or ended. Nothing while it is proposed. */
function PlanRowMenu({ plan, busy, onRemove }: { plan: BossPlan; busy: boolean; onRemove: () => void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [ending, setEnding] = useState(false);
  const going = plan.state === "running" || plan.state === "paused";
  const over = plan.state === "done" || plan.state === "dropped";
  if (!going && !over) return null;
  return (
    <>
      <button
        type="button"
        className="icon-btn-sm"
        aria-label={`More for the plan: ${plan.goal}`}
        aria-haspopup="menu"
        aria-disabled={busy || undefined}
        title={going ? "End plan" : "Remove from the board"}
        onClick={(e) => !busy && setAt(below(e.currentTarget))}
      >
        <MoreIcon />
      </button>
      {at && (
        <Menu
          label="Plan"
          at={at}
          onClose={() => setAt(null)}
          entries={[
            going
              ? { kind: "item", label: "End plan…", detail: "Stops it here; its tickets stay as they are", onSelect: () => setEnding(true) }
              : { kind: "item", label: "Remove", detail: "Takes it off the board; its tickets stay", onSelect: onRemove },
          ]}
        />
      )}
      {ending && (
        <Confirm title="End this plan?" action="End plan" onConfirm={() => usePlans.getState().end(plan.id)} onClose={() => setEnding(false)}>
          <p>
            “{plan.goal}” stops: its boss starts no more of its tickets and stops watching it. Its tickets stay where they are on the board, and any session on one is left to you. You can remove it from the board once it has ended.
          </p>
        </Confirm>
      )}
    </>
  );
}

/** A boss's plans on its Settings tab, a line each, newest first: those
 *  not done or dropped, each opening on its board. Nothing when it has
 *  none. */
export function BossPlans({ boss, name }: { boss: string; name: string }) {
  const all = usePlans((s) => s.plans);
  const plans = useMemo(
    () =>
      Object.values(all)
        .filter((p) => p.boss === boss && p.state !== "done" && p.state !== "dropped")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [all, boss],
  );
  if (plans.length === 0) return null;
  return (
    <section id="plans" className="agent-section" aria-labelledby="plans-head">
      <h2 id="plans-head">Plans</h2>
      <span className="small muted">What {name} is running on the board. Each plan's whole card is on its board.</span>
      <div className="plan-rows">
        {plans.map((p) => (
          <PlanRow key={p.id} plan={p} onToggle={() => openPlanOnBoard(p)} />
        ))}
      </div>
    </section>
  );
}
