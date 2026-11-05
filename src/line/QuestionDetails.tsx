import { RichMarkdown } from "@workforce/rich";
import type { LineMessage } from "../hub/types";
import { detailsOf } from "./questions";

/** What a question said beyond its one line, folded away until opened:
 *  why it asks, and its details as markdown. */
export function QuestionDetails({ m }: { m: LineMessage }) {
  const details = detailsOf(m);
  if (!details && !m.why) return null;
  return (
    <details className="msg-steps line-question-details">
      <summary className="small">Details</summary>
      {m.why && <p className="small muted">Why: {m.why}</p>}
      {details && <RichMarkdown text={details} />}
    </details>
  );
}
