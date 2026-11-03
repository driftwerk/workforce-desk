import { useRef, useState } from "react";
import { useDesk } from "../hub/store";
import { useFocusRequest } from "../shell/focus";
import { plainError } from "../ui/plainError";
import { useLine } from "./store";

/** What a question on a session's line offers you to answer with. */
export interface Asking {
  id: string;
  sessionId: string;
  /** Who asked: the session's name. */
  session: string;
  ask: string;
  /** Why Desk gave it to you, when it did. */
  why?: string | null;
  options?: string[] | null;
  /** Desk's own answer, for you to send or change. */
  draft?: string | null;
}

/** Answering a session's question: one of the answers offered, Desk's draft,
 *  or your own words. The first answer stands; another one gets "Already
 *  answered". With `focusKey`, the reply field takes focus when asked to
 *  (Reply… on the Floor). */
export function LineAnswer({ asking, focusKey, compact = false }: { asking: Asking; focusKey?: string; compact?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useFocusRequest(focusKey ?? null, field);
  const send = async (answer: string) => {
    const hub = useDesk.getState().hub;
    if (!hub || !answer.trim() || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const m = await hub.answerLine(asking.id, answer.trim());
      useLine.getState().heard(m);
      setSent(answer.trim());
      setText("");
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };
  if (sent) {
    return (
      <div className="line-answer line-answer-done" role="status">
        <span className="small state-done">You answered: “{sent}”</span>
      </div>
    );
  }
  return (
    <div className={`line-answer${compact ? " line-answer-compact" : ""}`} role="group" aria-label={`Answer ${asking.session}`}>
      {!compact && (
        <span className="line-answer-ask">
          <span className="small muted">{asking.session} asks</span>
          <span>{asking.ask}</span>
        </span>
      )}
      {asking.why && <span className="small faint">{asking.why}</span>}
      {(asking.options?.length || asking.draft) && (
        <span className="line-answer-options">
          {asking.draft && (
            <button type="button" className="btn btn-signal btn-sm" disabled={busy} title={asking.draft} onClick={() => void send(asking.draft!)}>
              Send Desk’s answer
            </button>
          )}
          {(asking.options ?? []).map((o) => (
            <button key={o} type="button" className="btn btn-sm" disabled={busy} onClick={() => void send(o)}>
              {o}
            </button>
          ))}
        </span>
      )}
      {asking.draft && <span className="small muted line-answer-draft">Desk would say: “{asking.draft}”</span>}
      <form
        className="line-answer-reply"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <textarea
          ref={field}
          rows={1}
          value={text}
          placeholder={`Answer ${asking.session}…`}
          aria-label={`Your answer to ${asking.session}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <button type="submit" className="btn btn-sm" disabled={busy || !text.trim()}>
          {busy ? "Sending…" : "Answer"}
        </button>
      </form>
      {problem && (
        <span className="small state-blocked" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}
