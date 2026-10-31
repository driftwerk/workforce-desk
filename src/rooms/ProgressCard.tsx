import { StatusLine, ToolChips, useNow } from "../chat/WorkingRow";
import type { RoomDraft } from "../hub/store";
import { progressOf, secsLabel, type Progress as Shown } from "./progress";

/** A list of steps: each tool, how it went, and how long it took. */
export function Steps({ steps }: { steps: Shown["steps"] }) {
  return (
    <ol className="prog-steps">
      {steps.map((s, i) => (
        <li key={i} className={`prog-step prog-${s.state}`}>
          <span className="prog-dot" aria-hidden="true">
            {s.state === "failed" || s.state === "unfinished" ? "×" : ""}
          </span>
          <span className="mono">{s.name}</span>
          <span className="faint small">{s.state === "unfinished" ? "unfinished" : s.state === "failed" ? `failed ${secsLabel(s.secs)}` : secsLabel(s.secs)}</span>
        </li>
      ))}
    </ol>
  );
}

/** What an answer on its way is doing: chips and its status while it's
 *  short, a card of its steps once it runs long or waits on you; Stop on a
 *  live one. */
export function Progress({ draft, asked = false, onStop }: { draft: RoomDraft; asked?: boolean; onStop?: () => void }) {
  const now = useNow();
  const p = progressOf(draft, now, asked);
  const stop = draft.state === "live" && onStop && (
    <button type="button" className="link small" title="Stop the answer" onClick={onStop}>
      Stop
    </button>
  );
  if (p.mode === "chips")
    return (
      <>
        <ToolChips tools={draft.tools} />
        {draft.state === "live" && (
          <span className="draft-live">
            {draft.working && <StatusLine working={draft.working} />}
            {stop}
          </span>
        )}
      </>
    );
  return (
    <div className={`prog${p.waiting ? " prog-waiting" : ""}`}>
      <span className="prog-head">
        <span className={p.waiting ? "state-blocked" : draft.state === "live" ? "state-working" : "faint"} aria-hidden="true">
          {p.header}
        </span>
        <span className="sr-only" aria-live="polite">
          {p.status}
        </span>
        {stop}
      </span>
      <Steps steps={p.steps} />
    </div>
  );
}
