import { useChat } from "../chat/store";
import { useSubHeading } from "./FloorShell";
import { useFloor } from "./store";
import { inWeek, KIND, planUse } from "./workUsage";

/** What each job, monitor and boss used of the plans, today and this week,
 *  from the local hub; nothing when it has none or can't say. */
export function WorkUsageCard() {
  const H = useSubHeading();
  const id = useChat((s) => s.hubs.find((h) => h.local)?.id);
  const work = useFloor((s) => (id ? s.hubs[id]?.work : null));
  const works = work ? inWeek(work.works) : [];
  if (works.length === 0) return null;
  return (
    <section
      className="floor-card plan-card"
      aria-label="Background work on your plans"
    >
      <div className="floor-card-head">
        <H className="display floor-card-title">
          Background work on your plans
        </H>
      </div>
      <ul className="plan-used-on">
        {works.map((w) => (
          <li key={w.work} className="plan-place">
            <span>
              <b>{w.label}</b> ·{" "}
              <span className="muted small">{KIND[w.kind]}</span>
            </span>
            <span className="plan-place-reading">{planUse(w)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
