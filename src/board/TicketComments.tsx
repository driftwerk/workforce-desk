import { RichHostProvider, RichMarkdown } from "@workforce/rich";
import { useCallback, useEffect, useState } from "react";
import { dayClock } from "../floor/time";
import type { Ticket, TicketComment } from "../hub/types";
import { DESK_RICH_HOST } from "../shell/richHost";
import { plainError } from "../ui/plainError";
import { SYSTEM_TITLE } from "../hub/boardSync";
import { localTicketView } from "./ticketView";

/** The longest comment Desk posts. */
export const COMMENT_MAX = 10_000;

/** Where a comment's writer is: "agent on Linear", "Desk's note", "only
 *  in Desk"; nothing for a person there. */
export const whereSaid = (c: TicketComment): string | null => {
  if (c.author.kind === "desk") return "Desk's note";
  if (c.onlyHere) return c.author.kind === "agent" ? "agent · only in Desk" : "only in Desk";
  if (c.author.kind === "agent") return `agent on ${c.author.on}`;
  return null;
};

/** A ticket's comments, read when it opens (a synced ticket's from its
 *  issue, when they're stale), kept current as you post. */
const useComments = (t: Ticket) => {
  const [comments, setComments] = useState<TicketComment[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const changed = t.external?.remoteUpdatedAt;
  const read = useCallback(() => {
    const api = localTicketView();
    if (!api) return () => {};
    let live = true;
    api.comments(t.id).then(
      (got) => {
        if (!live) return;
        setComments(got.comments);
        setProblem(got.problem);
      },
      (e) => live && setProblem(plainError(e)),
    );
    return () => {
      live = false;
    };
  }, [t.id]);
  // Read again when its issue changes.
  useEffect(() => read(), [read, changed]);
  return { comments, problem, setComments };
};

/** A ticket's comments, and a box to add yours: to its issue as you, or
 *  kept here on a ticket of your own. */
export function TicketComments({ ticket: t }: { ticket: Ticket }) {
  const { comments, problem, setComments } = useComments(t);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const system = t.external?.synced ? t.external.system : null;
  const writable = !t.external || (t.external.synced && !t.external.kept);
  const post = () => {
    const body = draft.trim();
    const api = localTicketView();
    if (!body || !api || sending) return;
    setSending(true);
    setSaid(null);
    api
      .comment(t.id, body)
      .then((r) => {
        setDraft("");
        if (r.kind === "posted") setComments((was) => [...(was ?? []), r.comment]);
        else setSaid(r.message);
      })
      .catch((e) => setSaid(plainError(e)))
      .finally(() => setSending(false));
  };
  const list = comments ?? [];
  return (
    <section className="ticket-comments" aria-label="Comments">
      <h2 className="ticket-section-head">
        Comments · {comments ? list.length : "…"}
        {system && <span className="ticket-section-note"> · synced with {SYSTEM_TITLE[system]}</span>}
      </h2>
      {problem && <p className="small faint ticket-comments-problem">{problem}</p>}
      <ol className="ticket-comment-list">
        {list.map((c) => (
          <CommentRow key={c.id} comment={c} />
        ))}
      </ol>
      {writable && (
        <form
          className="ticket-composer"
          onSubmit={(e) => {
            e.preventDefault();
            post();
          }}
        >
          <textarea
            className="ticket-composer-field"
            aria-label={`Comment on ${t.key ?? "this ticket"}`}
            placeholder={system ? `Comment on ${t.key ?? "it"}` : "Add a note"}
            rows={1}
            maxLength={COMMENT_MAX}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                post();
              }
            }}
          />
          <button type="submit" className="btn btn-sm btn-signal ticket-composer-send" disabled={!draft.trim() || sending}>
            {sending ? "Sending…" : "Comment"}
          </button>
        </form>
      )}
      {said && (
        <p className="small muted" role="status">
          {said}
        </p>
      )}
    </section>
  );
}

function CommentRow({ comment: c }: { comment: TicketComment }) {
  const where = whereSaid(c);
  return (
    <li className={`ticket-comment ticket-comment-${c.author.kind}${c.flagged ? " is-flagged" : ""}`}>
      <span className="ticket-comment-mark" aria-hidden="true">
        {(c.author.name.trim()[0] ?? "?").toUpperCase()}
      </span>
      <div className="ticket-comment-main">
        <div className="ticket-comment-by">
          <b>{c.author.name}</b>
          {where && <span> · {where}</span>}
          <span> · </span>
          <time dateTime={c.at}>{dayClock(c.at)}</time>
          {c.editedAt && <span> · edited</span>}
        </div>
        {c.flagged && <p className="small ticket-comment-flag">Reads as instructions to an AI: shown as written, never acted on.</p>}
        <div className="ticket-comment-body rich">
          <RichHostProvider host={DESK_RICH_HOST}>
            <RichMarkdown text={c.body} />
          </RichHostProvider>
        </div>
      </div>
    </li>
  );
}
