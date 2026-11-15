import { useDesk } from "../hub/store";
import type { ClosedLine, ClosedSession } from "../hub/types";
import { UNDO_LABEL, useUndo } from "./undo";

// The finished sessions an update speaks of, one line each: those the boss
// closed ("Closed 3 finished sessions: web, api, docs", each name with a
// faint Undo that reopens it), those it would close (its suggestions come
// with the update), and those it left open for work not committed or
// pushed, each with why.

export function ClosedLines({ lines }: { lines?: readonly ClosedLine[] | null }) {
  const shown = (lines ?? []).filter((l) => l.sessions.length > 0 && l.text.trim());
  if (!shown.length) return null;
  return (
    <ul className="brief-items closed-lines" aria-label="Finished sessions">
      {shown.map((l) => (
        <Line key={`${l.kind}:${l.sessions.map((s) => s.sessionId).join(",")}`} line={l} />
      ))}
    </ul>
  );
}

function Line({ line }: { line: ClosedLine }) {
  const closed = line.kind === "closed";
  const kept = line.kind === "keptOpen";
  const mark = closed ? "✓" : "●";
  const tone = closed ? "done" : kept ? "for-you" : "faint";
  // What it closed is said before the names, each name with its Undo.
  const cut = line.text.indexOf(": ");
  const head = closed && cut > 0 ? line.text.slice(0, cut) : null;
  return (
    <li className="brief-row">
      <span className={`brief-mark ${tone}`} aria-hidden>
        {mark}
      </span>
      <span className="brief-text">
        {head ? (
          <>
            <span className="brief-action">{head}: </span>
            {line.sessions.map((s, i) => (
              <Name key={s.sessionId} session={s} last={i === line.sessions.length - 1} />
            ))}
          </>
        ) : (
          <span className="brief-action">{line.text}</span>
        )}
      </span>
      <span className="brief-tools" />
    </li>
  );
}

/** A closed session's name, and its Undo (which reopens it). */
function Name({ session, last }: { session: ClosedSession; last: boolean }) {
  const connected = useDesk((s) => !!s.hub);
  const { isUndone, fixed, busy, problem, undo } = useUndo(session.decisionId ?? "", false);
  const can = !!session.decisionId && !!session.undo && !isUndone && !fixed;
  return (
    <span className="closed-name">
      <span className={isUndone ? "dec-undone" : undefined}>{session.name}</span>
      {can && (
        <button
          type="button"
          className="link closed-undo"
          aria-label={`${UNDO_LABEL[session.undo!]}: closed ${session.name}`}
          disabled={busy || !connected}
          onClick={() => void undo()}
        >
          {UNDO_LABEL[session.undo!]}
        </button>
      )}
      {isUndone && (
        <span className="faint small" role="status">
          {" "}
          reopened
        </span>
      )}
      {problem && (
        <span className="small state-blocked" role="alert">
          {" "}
          {problem}
        </span>
      )}
      {last ? "." : ", "}
    </span>
  );
}
