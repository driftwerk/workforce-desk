import { useLayoutEffect, useRef } from "react";
import { useDesk } from "../hub/store";
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
