import { useEffect, useId, useState } from "react";
import type { SpanKind } from "../hub/types";
import type { FloorLane } from "./merge";
import { useWhoName } from "./Row";
import { useFloor, useMerged } from "./store";
import { axis, box, LANE_CAP, ordered, type Axis } from "./timeline";
import { clock } from "./time";

const WHAT: Record<SpanKind, string> = { working: "working", waiting: "waited on you", background: "background work" };

/** Who worked today, and when something waited on the person: one lane each. */
export function Today({ now }: { now: number }) {
  const m = useMerged();
  const day = useFloor((s) => s.day);
  const [expanded, setExpanded] = useState(false);
  const grid = useId();
  useEffect(() => setExpanded(false), [day]);
  const lanes = ordered(
    m.lanes.filter((l) => l.spans.some((s) => s.to === null || Date.parse(s.to) >= day)),
    m.needs,
    m.working,
  );
  const a = axis(lanes, day, now);
  const shown = expanded ? lanes : lanes.slice(0, LANE_CAP);
  return (
    <section className="floor-card today" aria-label="Today">
      <div className="floor-card-head">
        <h2 className="display floor-card-title">Today</h2>
        <span className="muted small">who was working, and when something waited on you</span>
        <span className="today-legend small muted" aria-hidden="true">
          {(["working", "waiting", "background"] as const).map((k) => (
            <span key={k}>
              <span className={`today-key span-${k}`} /> {k === "waiting" ? "waiting on you" : WHAT[k]}
            </span>
          ))}
        </span>
      </div>
      {lanes.length === 0 ? (
        <p className="faint small">Nothing has run yet today.</p>
      ) : (
        <div id={grid} className="today-grid">
          {shown.map((l) => (
            <LaneRow key={l.key} lane={l} axis={a} />
          ))}
          <span />
          <div className="today-axis floor-time">
            {a.ticks.map((t) => (
              <span key={t} style={{ left: `${((t - a.from) / (a.to - a.from)) * 100}%` }}>
                {clock(t)}
              </span>
            ))}
            <span className="today-now-label">now {clock(now)}</span>
          </div>
        </div>
      )}
      {lanes.length > LANE_CAP && (
        <button type="button" className="link small" aria-expanded={expanded} aria-controls={grid} onClick={() => setExpanded((x) => !x)}>
          {expanded ? "Show fewer" : `Show ${lanes.length - LANE_CAP} more`}
        </button>
      )}
      {m.more.lanes > 0 && <p className="faint small">and {m.more.lanes} more earlier today</p>}
    </section>
  );
}

function LaneRow({ lane, axis: a }: { lane: FloorLane; axis: Axis }) {
  const name = useWhoName(lane);
  return (
    <>
      <span className={`today-name ${lane.who.kind === "session" ? "mono" : ""}`} title={name}>
        {name}
      </span>
      <div className="today-lane" role="group" aria-label={name}>
        {lane.spans.map((s) => {
          const { left, width } = box(s, a);
          const said = `${WHAT[s.kind]} ${clock(Math.max(a.from, Date.parse(s.from)))}–${s.to === null ? "now" : clock(s.to)}`;
          return (
            <span
              key={`${s.kind}@${s.from}`}
              className={`today-span span-${s.kind}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={said}
              aria-label={said}
              role="img"
            />
          );
        })}
        <span className="today-now" aria-hidden="true" />
      </div>
    </>
  );
}
