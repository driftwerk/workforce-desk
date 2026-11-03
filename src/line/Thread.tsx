import { useEffect, useState } from "react";
import { useDesk } from "../hub/store";
import type { LineMessage, Session } from "../hub/types";
import { plainError } from "../ui/plainError";
import { Composer } from "./Composer";
import { LineAnswer } from "./LineAnswer";
import { askedText, deliveryText, editable, headOf, lineOf, outgoing, waitsOnYou } from "./rows";
import { useLine } from "./store";
import { useNow } from "../chat/WorkingRow";

const NONE: LineMessage[] = [];

/** A session's line: what it, Desk, other sessions and you said to each
 *  other, newest at the bottom, each message saying where it stands; a
 *  question waiting on you is answered in place. The composer under it
 *  writes to the session. */
export function Thread({ session }: { session: Session }) {
  const loaded = useLine((s) => session.id in s.threads);
  const thread = useLine((s) => s.threads[session.id] ?? NONE);
  const problem = useLine((s) => s.problems[session.id]);
  const connected = useDesk((s) => !!s.hub);
  // Why a message waits is read with the thread: again as the session
  // moves on.
  useEffect(() => {
    if (connected) void useLine.getState().load(session.id);
  }, [connected, session.id, session.state, session.live]);
  const line = lineOf(session);
  const now = useNow();
  // Reply… on the Floor focuses the first question waiting on you.
  const first = thread.find(waitsOnYou)?.id;
  return (
    <section className="line" aria-label={`${session.displayName ?? session.name}'s line`}>
      {!loaded && !problem && connected && <p className="small faint line-note">Reading its line…</p>}
      {thread.length > 0 && (
        <ol className="line-thread">
          {thread.map((m) => (
            <Row key={m.id} m={m} session={session} now={now} focusKey={m.id === first ? `line:${session.id}` : `line:${session.id}:${m.id}`} />
          ))}
        </ol>
      )}
      {problem && <p className="small state-blocked line-note">Desk couldn’t read this session’s line: {problem}</p>}
      {line.on ? <Composer session={session} /> : <p className="small faint line-note">{line.why}</p>}
    </section>
  );
}

function Row({ m, session, now, focusKey }: { m: LineMessage; session: Session; now: number; focusKey: string }) {
  const out = outgoing(m, session.id);
  const status = [askedText(m), deliveryText(m, now)].filter(Boolean).join(" · ");
  const hop = m.from.kind === "session" && m.to.kind === "session" ? ` · hop ${m.hop}` : "";
  const waiting = m.delivery === "queued" || m.delivery === "held" || m.delivery === "handed";
  return (
    <li className={`line-row${out ? " line-row-out" : ""}${waiting && m.to.kind === "session" ? " line-row-waiting" : ""}`}>
      <span className="line-row-head small">
        <span className="strong">{headOf(m, session.id)}</span>
        <span className="faint">
          {hop}
          {status && ` · ${status}`}
        </span>
      </span>
      {editable(m) ? <Editable m={m} /> : <span className="line-row-text">{m.text}</span>}
      {waitsOnYou(m) && (
        <LineAnswer
          compact
          focusKey={focusKey}
          asking={{
            id: m.id,
            sessionId: session.id,
            session: m.from.name,
            ask: m.text,
            why: m.escalation?.why,
            options: m.escalation?.options,
            draft: m.escalation?.draft,
          }}
        />
      )}
    </li>
  );
}

/** Your message that hasn't gone out: changed or taken back until it does. */
function Editable({ m }: { m: LineMessage }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const act = async (f: () => Promise<void>) => {
    setProblem(null);
    try {
      await f();
    } catch (e) {
      setProblem(plainError(e));
    }
  };
  const finish = (text: string | null) => {
    setEditing(null);
    const hub = useDesk.getState().hub;
    if (text === null || !hub || text.trim() === m.text || !text.trim()) return;
    void act(() => hub.editLine(m.id, text.trim()));
  };
  return (
    <span className="queued line-queued">
      {editing === null ? (
        <span className="queued-text" title={m.text}>
          {m.text}
        </span>
      ) : (
        <textarea
          className="queued-edit"
          rows={1}
          autoFocus
          value={editing}
          aria-label="Edit your message"
          onChange={(e) => setEditing(e.target.value)}
          onBlur={() => finish(editing)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              finish(editing);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              finish(null);
            }
          }}
        />
      )}
      <span className="queued-actions">
        {editing === null && (
          <button type="button" className="icon-btn-sm" aria-label="Edit your message" onClick={() => setEditing(m.text)}>
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M9.5 2.5l2 2L5 11H3V9z" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="icon-btn-sm"
          aria-label="Take back your message"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const hub = useDesk.getState().hub;
            if (hub) void act(() => hub.takeBackLine(m.id));
            if (editing !== null) setEditing(null);
          }}
        >
          <svg width="11" height="11" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </span>
      {problem && (
        <span className="small state-blocked" role="alert">
          {problem}
        </span>
      )}
    </span>
  );
}
