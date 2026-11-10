import { RichMarkdown } from "@workforce/rich";
import { Actions } from "../chat/Actions";
import type { Advice } from "../hub/types";
import { StatusLine, ToolChips, useNow } from "../chat/WorkingRow";
import type { RoomDraft } from "../hub/store";
import { progressOf, secsLabel, type Progress as Shown } from "./progress";

/** A list of steps: each tool, how it went, and how long it took. */
export function Steps({ steps, live }: { steps: Shown["steps"]; live?: boolean }) {
  if (live === undefined) return <StepList steps={steps} first={0} />;
  return <Actions items={steps} live={live}>{(shown, first) => <StepList steps={shown} first={first} />}</Actions>;
}

type Shown1 = Shown["steps"][number];

/** A step's dot, its tool and how it went. */
function StepRow({ s }: { s: Shown1 }) {
  return (
    <>
      <span className="prog-dot" aria-hidden="true">
        {s.state === "failed" || s.state === "unfinished" ? "×" : ""}
      </span>
      <span className="mono">{s.name}</span>
      {s.advice?.model && <span className="chip step-advice-model">{s.advice.model}</span>}
      <span className="faint small">{s.state === "unfinished" ? "unfinished" : s.state === "failed" ? `failed ${secsLabel(s.secs)}` : secsLabel(s.secs)}</span>
    </>
  );
}

/** An advisor call, opened to what the agent asked and what it was told:
 *  the question as plain text, the answer as an agent's words are drawn. */
function AdviceStep({ s, advice }: { s: Shown1; advice: Advice }) {
  return (
    <details className="step-advice">
      <summary className={`prog-step prog-${s.state}`}>
        <StepRow s={s} />
      </summary>
      <div className="step-advice-body">
        <p className="step-advice-label small">Asked</p>
        {advice.question ? <p className="step-advice-question">{advice.question}</p> : <p className="muted small">A general review, with no question.</p>}
        <p className="step-advice-label small">{advice.unavailable ? "No advice" : "Answered"}</p>
        {advice.unavailable ? (
          <p className="muted small">{advice.answer}</p>
        ) : (
          <div className="msg-text rich">
            <RichMarkdown text={advice.answer} />
          </div>
        )}
        {advice.clipped && <p className="faint small">Cut short here; the agent has the whole answer.</p>}
      </div>
    </details>
  );
}

function StepList({ steps, first }: { steps: Shown["steps"]; first: number }) {
  return (
    <ol className="prog-steps">
      {steps.map((s, i) =>
        s.advice ? (
          <li key={first + i}>
            <AdviceStep s={s} advice={s.advice} />
          </li>
        ) : (
          <li key={first + i} className={`prog-step prog-${s.state}`}>
            <StepRow s={s} />
          </li>
        ),
      )}
    </ol>
  );
}

/** What an answer on its way is doing: chips and its status while it's
 *  short, a card of its steps once it runs long or waits on you; Stop on a
 *  live one. */
export function Progress({ draft, asked = false, onStop }: { draft: RoomDraft; asked?: boolean; onStop?: () => void }) {
  const now = useNow();
  const p = progressOf(draft, now, asked);
  const running = draft.state !== "failed" && draft.state !== "interrupted" && draft.state !== "stopped";
  const stop = draft.state === "live" && onStop && (
    <button type="button" className="link small" title="Stop the answer" onClick={onStop}>
      Stop
    </button>
  );
  if (p.mode === "chips")
    return (
      <>
        <ToolChips tools={draft.tools} live={running} />
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
      <Steps steps={p.steps} live={running} />
    </div>
  );
}
