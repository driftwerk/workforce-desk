import { useLayoutEffect, useRef, useState } from "react";
import { useDesk } from "../hub/store";
import type { Choice } from "../hub/floor";
import type { Session } from "../hub/types";
import { allowLabel } from "../session/Approval";
import { openTarget } from "../shell/navigate";
import { plainError } from "../ui/plainError";
import type { FloorNeed } from "./merge";
import { FloorRow, useStaleNote, useWhoName } from "./Row";
import { useFloor } from "./store";
import { placeLabel, targetOf } from "./target";
import { dayClock, durationOf } from "./time";

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

/** How a choice reads on `need`. */
const wordsOf = (need: FloorNeed, choice: Choice) =>
  isBreaker(need) && (choice === "allow" || choice === "deny") ? BREAKER[choice] : DECIDING[choice];

/** The answers a need offers, in the order they read: Codex says its own
 *  (an escalated command offers only Allow and Cancel); the rest allow or
 *  deny. */
const choicesOf = (need: FloorNeed): Choice[] => {
  if (need.answer.kind !== "decide") return [];
  const at = need.answer.at;
  if (at.kind !== "codex") return ["allow", "deny"];
  const order: Choice[] = ["allow", "allow_for_session", "deny", "cancel"];
  return order.filter((c) => at.choices.includes(c));
};

/** What still needs the person, as a row: it opens where it is (a session
 *  or a DM beside the Floor); with `actions` (Right now and Activity) it is
 *  answered there too, each button naming whose need it answers. */
export function NeedRow({ need, now, actions = false }: { need: FloorNeed; now: number; actions?: boolean }) {
  const rooms = useDesk((s) => s.rooms);
  // A session on this computer whose turn ended asking: what Desk read, and
  // what answers it here.
  const asking = useDesk((s): Session | null => {
    const session = need.local && need.who.kind === "session" ? s.sessions[need.who.id] : undefined;
    return session?.state === "asking" && session.asked ? session : null;
  });
  const [acting, setActing] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const act = (what: "allowAsked" | "dismissAsked") => () => {
    const hub = useDesk.getState().hub;
    if (!asking || !hub || acting) return;
    setActing(true);
    setRefused(null);
    hub[what](asking.id)
      .catch((e: unknown) => setRefused(plainError(e)))
      .finally(() => setActing(false));
  };
  const denied = asking?.asked?.denied ?? null;
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
        time={`waiting ${durationOf(need.since, now)} · since ${dayClock(need.since, now)}`}
        onOpen={open}
        tabbed={!actions}
      >
        {need.ask}
        {where && <span className="faint"> · {where}</span>}
        {asking?.asked && <span className="faint"> · {asking.asked.why}</span>}
        {need.why && <span className="floor-need-why faint small">{need.why}</span>}
      </FloorRow>
      {actions && (
        <span className="floor-need-buttons">
          {choicesOf(need).map((choice) => {
              const words = wordsOf(need, choice);
              const word = deciding === choice ? words.busy : words.word;
              return (
                <button
                  key={choice}
                  type="button"
                  className={choice === "allow" ? (isBreaker(need) ? "btn btn-blocked" : "btn btn-signal") : "btn"}
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
              className="btn btn-signal"
              aria-label={`${allowLabel(denied)}: ${name}`}
              disabled={need.stale || acting}
              title={denied.detail ? `Only ${denied.detail}, until the session ends` : undefined}
              onClick={act("allowAsked")}
            >
              {allowLabel(denied)}
            </button>
          )}
          {target && need.answer.kind === "reply" && (
            <button
              type="button"
              className="btn btn-signal"
              aria-label={`Reply to ${name}…`}
              disabled={need.stale || !!deciding}
              title={stale}
              onClick={() => openTarget(target, { beside: true, reply: true })}
            >
              Reply…
            </button>
          )}
          {target && (
            <button
              type="button"
              className="btn"
              aria-label={need.answer.kind === "terminal" ? `Open ${name} to answer in the terminal` : `Open ${name}`}
              disabled={need.stale || !!deciding}
              title={need.answer.kind === "terminal" ? "Answer in the terminal" : stale}
              onClick={() => openTarget(target, { beside: true, reply: need.answer.kind === "terminal" })}
            >
              Open
            </button>
          )}
          {asking && (
            <button type="button" className="btn" aria-label={`Dismiss what ${name} asked`} disabled={need.stale || acting} onClick={act("dismissAsked")}>
              Dismiss
            </button>
          )}
          <span className="sr-only" role="status">
            {deciding ? wordsOf(need, deciding).done : ""}
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
