import { useLayoutEffect, useRef, useState } from "react";
import { useDesk } from "../hub/store";
import type { Choice } from "../hub/floor";
import type { Session } from "../hub/types";
import { allowLabel } from "../session/Approval";
import { openTarget } from "../shell/navigate";
import { OptionChips } from "../ui/OptionChips";
import { dismissQuestions } from "../line/LinePanel";
import { useLinePanel } from "../line/panel";
import { plainError } from "../ui/plainError";
import type { FloorNeed } from "./merge";
import { FloorRow, useStaleNote, useWhoName } from "./Row";
import { useFloor } from "./store";
import { placeLabel, targetOf } from "./target";
import { dayClock, durationOf } from "./time";
import { hubFor } from "../hub/store";
import { sessionKeyOfItem } from "./needs";
import { usePlans } from "../crew/planStore";

/** Focus in a row that goes moves to the list it was in. */
const useFocusKept = () => {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = ref.current;
    return () => {
      if (row?.contains(document.activeElement)) row.closest<HTMLElement>('[role="list"]')?.focus();
    };
  }, []);
  return ref;
};

const DECIDING: Record<Choice, { word: string; busy: string; done: string }> = {
  allow: { word: "Allow", busy: "Allowed…", done: "Allowed" },
  allow_for_session: { word: "Allow for this session", busy: "Allowed…", done: "Allowed for this session" },
  deny: { word: "Deny", busy: "Denied…", done: "Denied" },
  cancel: { word: "Deny and stop", busy: "Stopped…", done: "Denied and stopped" },
};

/** What Desk's breaker holds is answered Continue or Keep paused (the
 *  hub's allow and deny). */
const BREAKER: Record<"allow" | "deny", { word: string; busy: string; done: string }> = {
  allow: { word: "Continue", busy: "Going on…", done: "Going on" },
  deny: { word: "Keep paused", busy: "Keeping it paused…", done: "Kept paused" },
};

const isBreaker = (need: FloorNeed): boolean => need.answer.kind === "decide" && need.answer.at.kind === "breaker";

/** A boss's plan to approve, or a change of scope to one: the plan's id. */
const planOf = (need: Pick<FloorNeed, "answer">): string | null =>
  need.answer.kind === "decide" && need.answer.at.kind === "plan" ? need.answer.at.plan : null;

/** A plan is approved (and runs) from the Floor; looking at it, editing or
 *  dropping it is in its boss's DM. */
const PLAN = {
  proposed: { word: "Approve and run", busy: "Approving…", done: "Approved: it starts", open: "Open in chat" },
  change: { word: "Approve", busy: "Approving…", done: "Approved", open: "Look" },
  failing: { word: "Continue", busy: "Going on…", done: "Going on", open: "Look" },
} as const;
const TURN_DOWN = { word: "Turn down", busy: "Turning it down…", done: "Turned down" };

/** What a plan's need asks: to approve the plan, a change of scope to it,
 *  or whether it goes on after its sessions kept failing to start. */
type PlanAsk = keyof typeof PLAN;

/** How a choice reads on `need` (`ask`: what a plan's need asks). */
const wordsOf = (need: FloorNeed, choice: Choice, ask: PlanAsk = "proposed") =>
  planOf(need) && choice === "allow"
    ? PLAN[ask]
    : planOf(need) && choice === "deny"
      ? TURN_DOWN
      : isBreaker(need) && (choice === "allow" || choice === "deny")
      ? BREAKER[choice]
      : DECIDING[choice];

/** The answers a need offers, in the order they read: Codex says its own
 *  (an escalated command offers only Allow and Cancel); the rest allow or
 *  deny. */
const choicesOf = (need: FloorNeed, ask: PlanAsk = "proposed"): Choice[] => {
  if (need.answer.kind !== "decide") return [];
  const at = need.answer.at;
  // A change of scope is approved or turned down; a plan's own Deny only
  // leaves it be (Open in chat is the other answer, to drop or edit it).
  if (at.kind === "plan") return ask === "change" ? ["allow", "deny"] : ["allow"];
  if (at.kind !== "codex") return ["allow", "deny"];
  const order: Choice[] = ["allow", "allow_for_session", "deny", "cancel"];
  return order.filter((c) => at.choices.includes(c));
};

/** Opens a session as the side panel beside the Floor (never in a grid,
 *  even when one shows it), with its questions shown under its terminal. */
export const goToQuestions = (sessionId: string): void => {
  // `sessionId` is the session's key (see `keyOf`).
  useLinePanel.getState().show(sessionId);
  openTarget({ kind: "session", sessionId }, { beside: true });
};

/** A question a session asked on its line: Go to session and Dismiss, on
 *  the Floor; it's taken up in the session's terminal. */
export const isLineNeed = (need: { id: string }): boolean => need.id.startsWith("line:");

/** What still needs the person, as a row: it opens where it is (a session
 *  or a DM beside the Floor); with `actions` (Right now and Activity) it is
 *  answered there too, each button naming whose need it answers. */
export function NeedRow({ need, now, actions = false }: { need: FloorNeed; now: number; actions?: boolean }) {
  const rooms = useDesk((s) => s.rooms);
  // A session on this computer whose turn ended asking: what Desk read, and
  // what answers it here.
  const asking = useDesk((s): Session | null => {
    const key = sessionKeyOfItem(need);
    const session = key ? s.sessions[key] : undefined;
    return session?.state === "asking" && session.asked ? session : null;
  });
  const [acting, setActing] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const ours = sessionKeyOfItem(need);
  const line = isLineNeed(need) && !!ours;
  const act = (what: "allowAsked" | "dismissAsked") => () => {
    const hub = asking ? hubFor(asking) : null;
    if (!asking || !hub || acting) return;
    setActing(true);
    setRefused(null);
    hub[what](asking.id)
      .catch((e: unknown) => setRefused(plainError(e)))
      .finally(() => setActing(false));
  };
  const denied = asking?.asked?.denied ?? null;
  const plan = planOf(need);
  // What a plan's need asks: by the revision it asks about against the
  // one approved (none approved, or the first, is the plan itself).
  const revision = need.answer.kind === "decide" && need.answer.at.kind === "plan" ? need.answer.at.revision : 0;
  const ask = usePlans((s): PlanAsk => {
    const p = plan ? s.plans[plan] : undefined;
    if (p && p.approvedRevision === revision && p.paused === "start_failing") return "failing";
    if (revision === 1 || p?.approvedRevision === null) return "proposed";
    return "change";
  });
  // A plan, or a change to it, is approved here only once the person has
  // seen that revision whole on its card (Look first); going on after its
  // starts kept failing approves nothing new.
  const looked = usePlans((s) => (plan ? (s.seen[plan] ?? 0) >= revision : true));
  const decides = !plan || ask === "failing" || looked;
  const deciding = useFloor((s) => s.deciding[need.key]);
  const problem = useFloor((s) => s.problems[need.key]) ?? refused;
  const stale = useStaleNote(need);
  const name = useWhoName(need);
  const ref = useFocusKept();
  const target = targetOf(need, rooms);
  const where = placeLabel(need.place, rooms);
  // Beside the Floor, as the Floor's tiles open, even when a grid shows it.
  const open = target ? () => openTarget(target, { beside: true }) : undefined;
  return (
    <div ref={ref} className={`floor-need ${actions ? "floor-need-acts" : ""}`}>
      <FloorRow
        item={need}
        look="blocked"
        time={
          line ? `waiting ${durationOf(need.since, now)} · it’s paused until you answer` : `waiting ${durationOf(need.since, now)} · since ${dayClock(need.since, now)}`
        }
        onOpen={open}
        tabbed={!actions}
      >
        {need.ask}
        {need.chose && <span className="faint"> It chose: {need.chose}</span>}
        {where && <span className="faint"> · {where}</span>}
        {asking?.asked && <span className="faint"> · {asking.asked.why}</span>}
        {need.why && <span className="floor-need-why faint small">{need.why}</span>}
      </FloorRow>
      <OptionChips options={need.options} className="floor-need-options" />
      {actions && (
        <span className="floor-need-buttons">
          {(decides ? choicesOf(need, ask) : []).map((choice) => {
              const words = wordsOf(need, choice, ask);
              const word = deciding === choice ? words.busy : words.word;
              return (
                <button
                  key={choice}
                  type="button"
                  className={choice === "allow" ? (plan ? "btn btn-signal" : isBreaker(need) ? "btn btn-blocked" : "btn btn-approve") : "btn"}
                  aria-label={`${word} “${need.ask}” for ${name}`}
                  disabled={need.stale}
                  aria-disabled={!!deciding}
                  title={stale}
                  onClick={() => !deciding && void useFloor.getState().decide(need.hubId, need, choice)}
                >
                  {word}
                </button>
              );
            })}
          {denied?.allowable && (
            <button
              type="button"
              className="btn btn-approve"
              aria-label={`${allowLabel(denied)}: ${name}`}
              disabled={need.stale || acting}
              title={denied.detail ? `Only ${denied.detail}, until the session ends` : undefined}
              onClick={act("allowAsked")}
            >
              {allowLabel(denied)}
            </button>
          )}
          {line && (
            <>
              <button
                type="button"
                className="btn btn-approve"
                aria-label={`Go to ${name}`}
                disabled={need.stale || acting}
                onClick={() => goToQuestions(ours!)}
              >
                Go to session
              </button>
              <button
                type="button"
                className="btn"
                aria-label={`Dismiss “${need.ask}” from ${name}`}
                disabled={need.stale || acting}
                onClick={() => {
                  setActing(true);
                  setRefused(null);
                  dismissQuestions([need.id.slice("line:".length)], need.machine)
                    .catch((e: unknown) => setRefused(plainError(e)))
                    .finally(() => setActing(false));
                }}
              >
                Dismiss
              </button>
            </>
          )}
          {!line && target && need.answer.kind === "reply" && (
            <button
              type="button"
              className="btn btn-approve"
              aria-label={`Reply to ${name}…`}
              disabled={need.stale || !!deciding}
              title={stale}
              onClick={() => openTarget(target, { beside: true, reply: true })}
            >
              Reply…
            </button>
          )}
          {plan && !decides && <span className="small faint">Look at it first</span>}
          {!line && target && (
            <button
              type="button"
              className="btn"
              aria-label={
                plan ? `${PLAN[ask].open}: ${name}'s plan` : need.answer.kind === "terminal" ? `Open ${name} to answer in the terminal` : `Open ${name}`
              }
              disabled={need.stale || !!deciding}
              title={need.answer.kind === "terminal" ? "Answer in the terminal" : stale}
              onClick={() => {
                // A plan opens on its card, scrolled to, to be looked at.
                if (plan) usePlans.getState().look(plan);
                openTarget(target, { beside: true, reply: need.answer.kind === "terminal" });
              }}
            >
              {plan ? PLAN[ask].open : "Open"}
            </button>
          )}
          {asking && (
            <button type="button" className="btn" aria-label={`Dismiss what ${name} asked`} disabled={need.stale || acting} onClick={act("dismissAsked")}>
              Dismiss
            </button>
          )}
          <span className="sr-only" role="status">
            {deciding ? wordsOf(need, deciding, ask).done : ""}
          </span>
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
