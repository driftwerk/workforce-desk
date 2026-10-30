import { useLayoutEffect, useRef, useState } from "react";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { toolName } from "../session/Approval";
import { openTarget } from "../shell/navigate";
import type { FloorNeed } from "./merge";
import { FloorRow, useStaleNote } from "./Row";
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

/** What still needs the person, as a row: it opens where it is (a session
 *  or a DM beside the Floor); in Activity it can also be answered there. */
export function NeedRow({ need, now, actions = false }: { need: FloorNeed; now: number; actions?: boolean }) {
  const rooms = useDesk((s) => s.rooms);
  // A session on this computer whose turn ended asking: what Desk read, and
  // what answers it here.
  const asking = useDesk((s): Session | null => {
    const session = need.local && need.who.kind === "session" ? s.sessions[need.who.id] : undefined;
    return session?.state === "asking" && session.asked ? session : null;
  });
  const [acting, setActing] = useState(false);
  const act = (what: "allowAsked" | "dismissAsked") => () => {
    const { hub, fail } = useDesk.getState();
    if (!asking || !hub || acting) return;
    setActing(true);
    hub[what](asking.id)
      .catch(fail)
      .finally(() => setActing(false));
  };
  const denied = asking?.asked?.denied ?? null;
  const deciding = useFloor((s) => s.deciding[need.key]);
  const problem = useFloor((s) => s.problems[need.key]);
  const stale = useStaleNote(need);
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
      </FloorRow>
      {actions && (
        <span className="floor-need-buttons">
          {need.answer.kind === "decide" && (
            <button
              type="button"
              className="btn btn-signal"
              disabled={need.stale}
              aria-disabled={!!deciding}
              title={stale}
              onClick={() => !deciding && void useFloor.getState().decide(need.hubId, need, "allow")}
            >
              {deciding ? "Allowed…" : "Allow"}
            </button>
          )}
          {denied?.allowable && (
            <button type="button" className="btn btn-signal" disabled={need.stale || acting} title={denied.detail ? `Only ${denied.detail}, until the session ends` : undefined} onClick={act("allowAsked")}>
              Allow {toolName(denied.tool)} for this session and continue
            </button>
          )}
          {target && need.answer.kind === "reply" && (
            <button type="button" className="btn btn-signal" disabled={need.stale || !!deciding} title={stale} onClick={() => openTarget(target, { reply: true })}>
              Reply
            </button>
          )}
          {target && (
            <button
              type="button"
              className="btn"
              disabled={need.stale || !!deciding}
              title={need.answer.kind === "terminal" ? "Answer in the terminal" : stale}
              onClick={() => openTarget(target, { reply: need.answer.kind === "terminal" })}
            >
              Open
            </button>
          )}
          {asking && (
            <button type="button" className="btn" disabled={need.stale || acting} onClick={act("dismissAsked")}>
              Dismiss
            </button>
          )}
          <span className="sr-only" role="status">
            {deciding ? "Allowed" : ""}
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
