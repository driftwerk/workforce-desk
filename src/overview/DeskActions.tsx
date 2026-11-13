import { useEffect, useState } from "react";
import { useDesk } from "../hub/store";
import type { DeskExtras } from "../hub/types";
import { plainError } from "../ui/plainError";
import { since } from "../floor/time";
import { openLocalDm, openSession, useKnownSession, useLocalAgent } from "./people";
import { useOverview } from "./store";
import { homeShort } from "../ui/paths";
import { ENGINE_TITLE } from "../engines/engines";
import { LineAnswer } from "../line/LineAnswer";
import { messageIn, useLine } from "../line/store";
import { PlanCard } from "../crew/PlanCard";

const ENGINE = ENGINE_TITLE;

type Approval = NonNullable<DeskExtras["approvals"]>[number];
type Mentioned = NonNullable<DeskExtras["suggestions"]>[number];
type Question = NonNullable<DeskExtras["questions"]>[number];

/** What an overseer's message mentions, to act on where it's said: a
 *  session's request to allow or deny, its suggestions, the questions it
 *  gave you, and its plan (`text`, the message's own words, shown while
 *  the plan can't be). `inline`: in the flow of the boss's update or
 *  needs-you, as the chat's own text does, never boxed. */
export function DeskActions({ extras, text, inline = false }: { extras: DeskExtras; text?: string; inline?: boolean }) {
  return (
    <>
      {extras.plan && <PlanCard mentioned={extras.plan} text={text} />}
      {(extras.approvals ?? []).map((a) => (
        <InlineApproval key={a.approvalId} approval={a} inline={inline} />
      ))}
      {(extras.suggestions ?? []).map((s) => (
        <SuggestionCard key={s.id} mentioned={s} inline={inline} />
      ))}
      {(extras.questions ?? []).map((q) => (
        <QuestionCard key={q.messageId} question={q} inline={inline} />
      ))}
    </>
  );
}

function InlineApproval({ approval, inline }: { approval: Approval; inline: boolean }) {
  const session = useDesk((s) => s.sessions[approval.sessionId]);
  const item = useOverview((s) => s.overview?.items.find((i) => i.approval?.id === approval.approvalId));
  const decided = useOverview((s) => s.decided[approval.approvalId]);
  const decide = useOverview((s) => s.decide);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = session?.pending?.id === approval.approvalId ? session.pending : null;
  // Still waiting: the session says so, or (a session Desk doesn't list) the overview does.
  const waiting = session ? !!pending : !!item;
  const meta = pending
    ? [`Waiting ${since(pending.since)}`, `${ENGINE[session!.engine]} in ${homeShort(session!.cwd)}`].join(" · ")
    : item
      ? [`Waiting ${since(item.since)}`, item.engine ? ENGINE[item.engine] : null].filter(Boolean).join(" · ")
      : null;

  const answer = async (d: "allow" | "deny") => {
    setBusy(true);
    setProblem(null);
    try {
      await decide(approval.sessionId, approval.approvalId, d);
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };

  return (
    <div className={`${inline ? "dm-inline" : "dm-action"} dm-approval`} role="group" aria-label={approval.summary}>
      <span className="dm-action-text">
        <span>{approval.summary}</span>
        {decided ? (
          <span className={decided === "allow" ? "small state-done" : "small faint"} role="status">
            {decided === "allow" ? "You allowed this." : "You denied this."}
          </span>
        ) : waiting && meta ? (
          <span className="small muted">{meta}</span>
        ) : (
          !waiting && <span className="small faint">Already answered.</span>
        )}
        {problem && <span className="small state-blocked">{problem}</span>}
      </span>
      {!decided && waiting && pending && !pending.answerable ? (
        <button type="button" className="btn btn-ghost" onClick={() => useDesk.getState().open(approval.sessionId)}>
          Answer in the terminal
        </button>
      ) : (
        !decided &&
        waiting && (
          <span className="dm-action-buttons">
            <button type="button" className="btn btn-approve" disabled={busy} onClick={() => void answer("allow")}>
              Allow
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void answer("deny")}>
              Deny
            </button>
          </span>
        )
      )}
    </div>
  );
}

function SuggestionCard({ mentioned, inline }: { mentioned: Mentioned; inline: boolean }) {
  const live = useOverview((s) => s.suggestions[mentioned.id]);
  const { accept, dismiss, wantSuggestions } = useOverview();
  const [busy, setBusy] = useState<"accept" | "dismiss" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => wantSuggestions(), [wantSuggestions]);
  const state = live?.state ?? mentioned.state;
  const subject = live?.subject;
  const knownSession = useKnownSession(subject?.kind === "session" ? subject.id : null);
  const knownAgent = useLocalAgent(subject?.kind === "agent" ? subject.id : null);
  const opens = subject?.kind === "session" ? knownSession : !!knownAgent;
  const text = live?.text || mentioned.text;

  const act = async (what: "accept" | "dismiss") => {
    setBusy(what);
    setProblem(null);
    try {
      await (what === "accept" ? accept(mentioned.id) : dismiss(mentioned.id));
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(null);
  };
  const open = () => {
    if (!subject) return;
    if (subject.kind === "session") openSession(subject.id);
    else openLocalDm(subject.id);
  };

  return (
    <div className={`${inline ? "dm-inline" : "dm-action"} dm-suggestion dm-suggestion-${state}`} role="group" aria-label="Suggestion">
      <span className="small muted">Suggestion</span>
      <span className="dm-suggestion-text">{text}</span>
      {state === "open" ? (
        <span className="dm-action-buttons">
          <button type="button" className="btn btn-signal" disabled={busy !== null} onClick={() => void act("accept")}>
            {busy === "accept" ? "Doing it…" : "Do it"}
          </button>
          {subject && opens && (
            <button type="button" className="btn" onClick={open}>
              {subject.kind === "session" ? "Open session" : `Open ${subject.name}`}
            </button>
          )}
          <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void act("dismiss")}>
            Dismiss
          </button>
        </span>
      ) : (
        <span className={state === "done" ? "small state-done" : "small faint"} role="status">
          {state === "done" ? "Done." : "Dismissed."}
        </span>
      )}
      {problem && <span className="small state-blocked">{problem}</span>}
    </div>
  );
}

/** A question a session asked on its line that the overseer gave you:
 *  answered here, or already answered (here, on the Floor, in the
 *  session's thread, or by the overseer). `inline`: under the message that
 *  already says the question, so only its answers show. */
function QuestionCard({ question, inline }: { question: Question; inline: boolean }) {
  const live = useLine((s) => messageIn(s.threads, question.messageId));
  const loaded = useLine((s) => question.sessionId in s.threads);
  const connected = useDesk((s) => !!s.hub);
  const known = useKnownSession(question.sessionId);
  useEffect(() => {
    if (connected && !loaded && known) void useLine.getState().load(question.sessionId);
  }, [connected, loaded, known, question.sessionId]);
  const open = live ? live.asked === "open" || live.asked === "escalated" : !loaded || !known;
  return (
    <div className={`${inline ? "dm-inline" : "dm-action"} dm-question`} role="group" aria-label={`${question.session}'s question`}>
      {!inline && (
        <span className="dm-action-text">
          <span className="small muted">{question.session} asks</span>
          <span>{question.ask}</span>
        </span>
      )}
      {open ? (
        <LineAnswer
          compact
          asking={{
            id: question.messageId,
            sessionId: question.sessionId,
            session: question.session,
            ask: question.ask,
            why: inline ? undefined : question.why,
            options: question.options,
            draft: question.draft,
          }}
        />
      ) : (
        <span className="small faint" role="status">
          {live?.asked === "withdrawn" ? "Withdrawn: the session has ended." : "Already answered."}
        </span>
      )}
      {known && (
        <button type="button" className="link small" onClick={() => openSession(question.sessionId)}>
          Open {question.session}
        </button>
      )}
    </div>
  );
}
