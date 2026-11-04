import { useEffect, useRef, useState } from "react";
import { useDesk } from "../hub/store";
import type { LineMessage, Session } from "../hub/types";
import { plainError } from "../ui/plainError";
import { useNow } from "../chat/WorkingRow";
import { PANEL_HEIGHT, PANEL_MIN, useLinePanel } from "./panel";
import { anyOpen, barText, discussText, openOf, statusOf } from "./questions";
import { useLine } from "./store";
import { Thread, useThread } from "./Thread";

/** Why Discuss in terminal can't put the questions in its prompt now. */
export const discussBlocked = (s: Session): string | null => {
  if (!s.live) return "It isn't running; resume it first.";
  if (s.state === "blocked") return "It's showing a dialog in its terminal; answer that first.";
  return null;
};

/** Sets questions aside unanswered: each leaves the Floor, the bar and the
 *  panel, and nothing is sent to the session. */
export const dismissQuestions = async (ids: readonly string[]): Promise<void> => {
  const hub = useDesk.getState().hub;
  if (!hub) return;
  for (const id of ids) useLine.getState().heard(await hub.dismissLine(id));
};

/** What sits under a session's terminal for its line. Nothing at all while
 *  nothing on it is open; a slim bar saying what is (its questions to you,
 *  messages waiting to go in), with Show; shown, a panel you can drag
 *  taller or shorter that lists them. Messages with Desk… (its menu) shows
 *  the whole line in the same place. Desk's own view of a session keeps the
 *  thread with its composer. */
export function LinePanel({ session }: { session: Session }) {
  if (session.view === "desk") return <Thread session={session} />;
  return <TerminalLine session={session} />;
}

function TerminalLine({ session }: { session: Session }) {
  const { thread } = useThread(session);
  const open = openOf(thread, session.id);
  const mode = useLinePanel((s) => s.shown[session.id]);
  if (mode === "history") {
    return (
      <Panel session={session} title="Messages with Desk">
        <Thread session={session} history />
      </Panel>
    );
  }
  if (!anyOpen(open)) return null;
  if (!mode) return <Bar session={session} text={barText(open)} />;
  return (
    <Panel session={session} title="Questions from this session" questions={open.questions}>
      <Questions session={session} questions={open.questions} waiting={open.waiting} />
    </Panel>
  );
}

function Bar({ session, text }: { session: Session; text: string }) {
  return (
    <div className="line-bar" role="status">
      <span className="dot dot-blocked" aria-hidden="true" />
      <span className="line-bar-text small" title={text}>
        {text}
      </span>
      <button type="button" className="btn btn-sm line-bar-show" aria-label={`Show: ${text}`} onClick={() => useLinePanel.getState().show(session.id)}>
        Show
      </button>
    </div>
  );
}

/** The panel's frame: a handle to drag it taller or shorter (or the arrow
 *  keys on it), its header with what acts on every question, and what it
 *  holds, scrolling. */
function Panel({ session, title, questions, children }: { session: Session; title: string; questions?: LineMessage[]; children: React.ReactNode }) {
  const height = useLinePanel((s) => s.heights[session.id]) ?? PANEL_HEIGHT;
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => () => document.body.classList.remove("line-resizing"), []);
  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      await f();
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };
  const blocked = discussBlocked(session);
  const text = questions?.length ? discussText(questions) : "";
  const shownHeight = () => ref.current?.getBoundingClientRect().height ?? height;
  return (
    <section ref={ref} className="line-panel" style={{ height }} aria-label={title}>
      <div
        className="line-panel-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize this panel"
        aria-valuenow={Math.round(height)}
        aria-valuemin={PANEL_MIN}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, h: shownHeight() };
          document.body.classList.add("line-resizing");
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d && e.currentTarget.hasPointerCapture(e.pointerId)) useLinePanel.getState().setHeight(session.id, d.h + (d.y - e.clientY));
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          drag.current = null;
          document.body.classList.remove("line-resizing");
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          document.body.classList.remove("line-resizing");
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          useLinePanel.getState().setHeight(session.id, shownHeight() + (e.key === "ArrowUp" ? 24 : -24));
        }}
      />
      <header className="line-panel-head">
        <span className="line-panel-title strong">{title}</span>
        <span className="line-panel-actions">
          {!!questions?.length && (
            <>
              <button
                type="button"
                className="btn btn-signal btn-sm"
                disabled={busy || !!blocked}
                title={blocked ?? "Put these questions, with what it chose, in its prompt without sending"}
                onClick={() =>
                  void act(async () => {
                    await useDesk.getState().hub?.draftLine(session.id, text);
                    setNote("In its prompt: add your words and send them in the terminal.");
                  })
                }
              >
                Discuss in terminal
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await navigator.clipboard.writeText(text);
                    setNote("Copied.");
                  })
                }
              >
                Copy all
              </button>
              <button type="button" className="link small" disabled={busy} onClick={() => void act(() => dismissQuestions(questions.map((m) => m.id)))}>
                Dismiss all
              </button>
            </>
          )}
          <button type="button" className="link small" onClick={() => useLinePanel.getState().hide(session.id)}>
            Hide
          </button>
        </span>
      </header>
      {(problem || note) && (
        <p className={`small line-note ${problem ? "state-blocked" : "muted"}`} role={problem ? "alert" : "status"}>
          {problem ?? note}
        </p>
      )}
      <div className="line-panel-body">{children}</div>
    </section>
  );
}

function Questions({ session, questions, waiting }: { session: Session; questions: LineMessage[]; waiting: LineMessage[] }) {
  const now = useNow();
  return (
    <>
      {questions.length > 0 && (
        <ol className="line-questions">
          {questions.map((m) => (
            <Question key={m.id} m={m} now={now} />
          ))}
        </ol>
      )}
      {waiting.length > 0 && (
        <p className="small muted line-note">
          {waiting.length === 1 ? "1 message waits" : `${waiting.length} messages wait`} to go in once {session.displayName ?? session.name} is free. Messages
          with Desk… in its menu shows them.
        </p>
      )}
      {questions.length > 0 && (
        <p className="small faint line-note">
          Discuss in terminal puts these questions, with what it chose, into the session’s prompt without sending, so you can add your own words.
        </p>
      )}
    </>
  );
}

function Question({ m, now }: { m: LineMessage; now: number }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <li className="line-question">
      <span className="small state-blocked">{statusOf(m, now)}</span>
      <span className="line-question-text">{m.text}</span>
      <span className="line-question-foot">
        <span className="small muted line-question-chose">{m.chose ? `It chose: ${m.chose}` : ""}</span>
        <button
          type="button"
          className="btn btn-sm"
          aria-label={`Dismiss “${m.text}”`}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setProblem(null);
            dismissQuestions([m.id])
              .catch((e: unknown) => setProblem(plainError(e)))
              .finally(() => setBusy(false));
          }}
        >
          Dismiss
        </button>
      </span>
      {problem && (
        <span className="small state-blocked" role="alert">
          {problem}
        </span>
      )}
    </li>
  );
}
