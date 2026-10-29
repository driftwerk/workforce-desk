import { useDesk } from "../hub/store";
import { openTarget } from "../shell/navigate";
import type { FloorNeed } from "./merge";
import { FloorRow, useStaleNote } from "./Row";
import { useFloor } from "./store";
import { placeLabel, targetOf } from "./target";
import { dayClock, durationOf } from "./time";

/** What still needs the person, as a row: in Right now it opens where it
 *  is; in Activity it can also be answered there. */
export function NeedRow({ need, now, actions = false }: { need: FloorNeed; now: number; actions?: boolean }) {
  const rooms = useDesk((s) => s.rooms);
  const deciding = useFloor((s) => s.deciding[need.key]);
  const problem = useFloor((s) => s.problems[need.key]);
  const stale = useStaleNote(need);
  const target = targetOf(need, need.hubId, rooms);
  const where = placeLabel(need.place, rooms);
  const open = () => openTarget(target);
  return (
    <div className={`floor-need ${actions ? "floor-need-acts" : ""}`}>
      <FloorRow item={need} look="blocked" time={`waiting ${durationOf(need.since, now)} · since ${dayClock(need.since, now)}`} onOpen={open}>
        {need.ask}
        {where && <span className="faint"> · {where}</span>}
      </FloorRow>
      {actions && (
        <span className="floor-need-buttons">
          {deciding ? (
            <span className="small state-done" role="status">
              {deciding === "allow" ? "Allowed…" : "Denied…"}
            </span>
          ) : (
            <>
              {need.answer.kind === "decide" && (
                <button
                  type="button"
                  className="btn btn-signal"
                  disabled={need.stale}
                  title={stale}
                  onClick={() => void useFloor.getState().decide(need.hubId, need, "allow")}
                >
                  Allow
                </button>
              )}
              {need.answer.kind === "reply" && (
                <button
                  type="button"
                  className="btn btn-signal"
                  disabled={need.stale}
                  title={stale}
                  onClick={() => openTarget(target, { reply: true })}
                >
                  Reply
                </button>
              )}
              <button
                type="button"
                className="btn"
                disabled={need.stale}
                title={need.answer.kind === "terminal" ? "Answer in the terminal" : stale}
                onClick={() => openTarget(target, { reply: need.answer.kind === "terminal" })}
              >
                Open
              </button>
            </>
          )}
          {problem && <span className="small state-blocked">{problem}</span>}
        </span>
      )}
    </div>
  );
}
