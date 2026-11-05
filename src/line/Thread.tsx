import { useEffect, useMemo, useState } from "react";
import { driving } from "../crew/charge";
import { useCharge } from "../crew/chargeStore";
import { useDesk } from "../hub/store";
import type { LineMessage, Session } from "../hub/types";
import { plainError } from "../ui/plainError";
import { Composer } from "./Composer";
import { LineAnswer } from "./LineAnswer";
import { headlineOf } from "./questions";
import { QuestionDetails } from "./QuestionDetails";
import { askedText, deliveryText, editable, headOf, lineOf, outgoing, waitsOnYou, withWheel } from "./rows";
import { useLine } from "./store";
import { useNow } from "../chat/WorkingRow";

const NONE: LineMessage[] = [];

/** A session's line as Desk has it, read from the hub (again as the
 *  session moves on, for why a message waits), with whether it was read
 *  and why it couldn't be. */
export const useThread = (session: Session) => {
  const loaded = useLine((s) => session.id in s.threads);
  const kept = useLine((s) => s.threads[session.id] ?? NONE);
  // A boss's message that came while you drive waits on you: the hub says
  // why only when the thread is read.
  const charge = useCharge(session.id);
  const thread = useMemo(() => withWheel(kept, session.id, !!charge && driving(charge)), [kept, session.id, charge]);
  const problem = useLine((s) => s.problems[session.id]);
  const connected = useDesk((s) => !!s.hub);
  // Why a message waits is read with the thread: again as the session
  // moves on.
  useEffect(() => {
    if (connected) void useLine.getState().load(session.id);
  }, [connected, session.id, session.state, session.live]);
  return { thread, loaded, problem, connected };
};

/** A session's line: what it, Desk, other sessions and you said to each
 *  other, newest at the bottom, each message saying where it stands. In
 *  Desk's own view of a session, a question waiting on you is answered in
 *  place and the composer under it writes to the session; as `history`
 *  (a terminal session's Messages with Desk), it is only read: you talk to
 *  a terminal session in its terminal. */
export function Thread({ session, history = false }: { session: Session; history?: boolean }) {
  const { thread, loaded, problem, connected } = useThread(session);
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
            <Row
              key={m.id}
              m={m}
              session={session}
              now={now}
              answers={!history}
              focusKey={m.id === first ? `line:${session.id}` : `line:${session.id}:${m.id}`}
            />
          ))}
        </ol>
      )}
      {problem && <p className="small state-blocked line-note">Desk couldn’t read this session’s line: {problem}</p>}
      {loaded && history && thread.length === 0 && <p className="small faint line-note">Nothing on its line yet.</p>}
      {history ? null : line.on ? <Composer session={session} /> : <p className="small faint line-note">{line.why}</p>}
    </section>
  );
}

function Row({ m, session, now, focusKey, answers }: { m: LineMessage; session: Session; now: number; focusKey: string; answers: boolean }) {
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
      {editable(m) ? <Editable m={m} /> : <span className="line-row-text">{m.kind === "ask" ? headlineOf(m) : m.text}</span>}
      {m.kind === "ask" && <QuestionDetails m={m} />}
      {answers && waitsOnYou(m) && (
        <LineAnswer
          compact
          focusKey={focusKey}
          asking={{
            id: m.id,
            sessionId: session.id,
            session: m.from.name,
            ask: headlineOf(m),
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
