import { RichHostProvider, RichMarkdown } from "@workforce/rich";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useChat } from "../chat/store";
import { dayClock } from "../floor/time";
import { useSessionNames } from "../groups/names";
import { deskListeners, useDesk } from "../hub/store";
import type { ActivityEvent, DeskEvent, HistoryEvent, Ticket, TicketComment } from "../hub/types";
import { mergeEvents } from "../overview/activity";
import { parseTicketLink } from "../shell/links";
import { DESK_RICH_HOST } from "../shell/richHost";
import { plainError } from "../ui/plainError";
import { historyLine } from "./board";
import { BranchIcon, MergeIcon, PrIcon } from "./cardFacts";
import { useBoard } from "./store";
import { counts, dayText, eventParts, filtered, markText, timeline, type ActivityFilter, type EventWords, type Layout, type Part, type TimelineRow } from "./ticketRich";
import { linkTicketKeys } from "./ticketKeys";
import { IssueChip } from "./IssueChip";
import { localTicketView } from "./ticketView";

/** A comment's markdown host: Desk's, with a link to a ticket on a board
 *  here drawn as that ticket's chip. */
const COMMENT_HOST = {
  ...DESK_RICH_HOST,
  link: (href: string, children: ReactNode) => {
    const id = parseTicketLink(href);
    return id && useBoard.getState().tickets[id] ? <IssueChip id={id}>{children}</IssueChip> : undefined;
  },
};

/** The longest comment Desk posts. */
export const COMMENT_MAX = 10_000;

/** Where a comment's writer is, beside their name: "agent on Linear",
 *  "Desk's note", "only in Desk"; nothing for a person there. */
export const whereSaid = (c: TicketComment): string | null => {
  if (c.author.kind === "desk") return "Desk's note";
  if (c.onlyHere) return "only in Desk";
  if (c.author.kind === "agent") return `agent on ${c.author.on}`;
  return null;
};

/** Who a comment went to its issue for, when Desk's agent, a session or
 *  the boss posted it there as the person: said "Desk on behalf of
 *  <them>", never as the person's own words. Null for the person's own,
 *  and for a note that stays in Desk. */
export const onBehalfOf = (c: TicketComment, t: Ticket, person: string | null | undefined): string | null => {
  const by = c.postedBy?.kind;
  if (!by || by === "you" || by === "desk" || !t.external?.synced || c.onlyHere) return null;
  return `Desk on behalf of ${person?.trim() || "you"}`;
};

/** A ticket's comments, read when it opens (a synced ticket's from its
 *  issue, when they're stale), kept current as you post; with them, what
 *  happened to its issue there, from a hub that reads it. */
const useComments = (t: Ticket) => {
  const [comments, setComments] = useState<TicketComment[] | null>(null);
  const [remote, setRemote] = useState<HistoryEvent[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const changed = t.external?.remoteUpdatedAt;
  // Read once this computer's hub is known, if it wasn't yet.
  const hubKnown = useChat((s) => s.hubs.some((h) => h.local));
  const read = useCallback(() => {
    const api = localTicketView();
    if (!api) {
      setProblem("This computer's hub isn't there yet.");
      return () => {};
    }
    let live = true;
    api.comments(t.id).then(
      (got) => {
        if (!live) return;
        setComments(got.comments);
        setRemote(got.history ?? []);
        setProblem(got.problem);
      },
      (e) => live && setProblem(plainError(e)),
    );
    return () => {
      live = false;
    };
    // Read again once the hub is known.
  }, [t.id, hubKnown]);
  // Read again when its issue changes.
  useEffect(() => read(), [read, changed]);
  return { comments, remote, problem, setComments };
};

/** A ticket's history as Desk kept it, newest first; the next page older,
 *  and what happens to it meanwhile as it happens. */
export const useTicketHistory = (t: Ticket): { events: ActivityEvent[]; more: boolean; older: () => void; problem: string | null } => {
  const hub = useDesk((s) => s.hub);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Older pages shown stay shown as the newest is read again.
  const olderRead = useRef(false);
  const changed = t.updatedAt;
  useEffect(() => {
    if (!hub) return;
    let live = true;
    hub
      .ticketHistory(t.id)
      .then((p) => {
        if (!live) return;
        setEvents((was) => mergeEvents(was, p.events));
        if (!olderRead.current) setMore(p.more);
        setProblem(null);
      })
      .catch((e) => live && setProblem(plainError(e)));
    return () => {
      live = false;
    };
  }, [hub, t.id, changed]);
  useEffect(() => {
    const listen = (e: DeskEvent) => {
      if (e.type === "activity" && e.event.ticket === t.id) setEvents((was) => mergeEvents(was, [e.event]));
    };
    deskListeners.add(listen);
    return () => void deskListeners.delete(listen);
  }, [t.id]);
  const older = () => {
    const last = events.at(-1);
    if (!hub || !last) return;
    hub
      .ticketHistory(t.id, last.id)
      .then((p) => {
        olderRead.current = true;
        setEvents((was) => mergeEvents(was, p.events));
        setMore(p.more);
      })
      .catch((e) => setProblem(plainError(e)));
  };
  return { events, more, older, problem };
};

const FILTERS: { id: ActivityFilter; word: string }[] = [
  { id: "all", word: "All" },
  { id: "comments", word: "Comments" },
  { id: "history", word: "History" },
  { id: "desk", word: "Only in Desk" },
];

/** What happened to a ticket, in one timeline: its comments (Linear's
 *  replies under theirs), Desk's own history of it, and its issue's there,
 *  by time; a filter for each, and a box to add yours (to its issue as
 *  you, or kept here on a ticket of your own). In the shortest view, the
 *  newest of it, the rest a click away. */
/** `onCount`: told how many comments and history rows it has, for a fold
 *  that says so while shut (an epic's). */
export function TicketActivity({ ticket: t, layout = "wide", onCount }: { ticket: Ticket; layout?: Layout; onCount?: (n: number) => void }) {
  const { comments, remote, problem, setComments } = useComments(t);
  const history = useTicketHistory(t);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [earlier, setEarlier] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const system = t.external?.synced ? t.external.system : null;
  const writable = !t.external || (t.external.synced && !t.external.kept);
  const sync = useBoard((s) => s.boards[t.board]?.sync);
  const names = useSessionNames();
  const roster = useChat((s) => s.roster);
  const rows = useMemo(() => timeline(comments ?? [], [...history.events].reverse(), remote), [comments, history.events, remote]);
  const n = counts(rows);
  const words: EventWords = {
    system,
    me: sync?.meName,
    ticketKey: t.key,
    actorName: (e) =>
      e.actor.kind === "you"
        ? "You"
        : e.actor.kind === "session"
          ? (names[e.actor.id] ?? e.actor.name)
          : e.actor.kind === "agent"
            ? (roster.find((a) => a.id === e.actor.id)?.name ?? e.actor.name)
            : e.actor.kind === "desk" || (e.actor.kind as string) === "remote"
              ? "Desk"
              : e.actor.name,
    deskLine: (e) => {
      const line = historyLine(e, t.key);
      return line.quote !== null ? `${line.text} “${line.quote}”` : line.text;
    },
  };
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
  const total = n.comments + n.history;
  useEffect(() => onCount?.(total), [onCount, total]);
  const compact = layout === "compact";
  // The shortest view has no History or Only in Desk chip: shrunk to it
  // with one of those on, it shows all again.
  useEffect(() => {
    if (compact && (filter === "history" || filter === "desk")) setFilter("all");
  }, [compact, filter]);
  // The shortest view keeps its chips to All and Comments.
  const chips = FILTERS.filter((f) => (compact ? f.id === "all" || f.id === "comments" : f.id !== "desk" || (system && n.desk > 0)));
  const shown = filtered(rows, filter);
  const folded = compact && !earlier && shown.length > 1;
  const list = folded ? shown.slice(-1) : shown;
  const count = (f: ActivityFilter): string =>
    f === "all" ? "" : f === "comments" && !comments ? (problem ? "" : " · …") : ` · ${f === "comments" ? n.comments : f === "history" ? n.history : n.desk}`;
  return (
    <section className="ticket-activity" aria-label="Activity">
      <div className="ticket-sec-head">
        <h2 className="ticket-section-head">Activity</h2>
        <span className="ticket-sec-gap" />
        <span className="ticket-filters" role="group" aria-label="Show">
          {chips.map((f) => (
            <button key={f.id} type="button" className="chip-btn" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.word}
              {count(f.id)}
            </button>
          ))}
        </span>
      </div>
      {problem && <p className="small faint ticket-comments-problem">{problem}</p>}
      {history.problem && <p className="small state-blocked">{history.problem}</p>}
      {folded && (
        <button type="button" className="link small ticket-earlier" onClick={() => setEarlier(true)}>
          Show the {shown.length - 1} before it
        </button>
      )}
      <ol className="ticket-timeline">
        {list.map((r) =>
          r.kind === "comment" ? (
            <CommentRow key={r.comment.id} comment={r.comment} replies={r.replies} ticket={t} me={sync?.meName} person={sync?.meName} />
          ) : (
            <EventRow key={r.kind === "desk" ? r.event.id : `${r.event.at}:${r.event.kind}:${r.event.field ?? ""}:${r.event.to ?? ""}`} row={r} words={words} wide={layout === "wide"} />
          ),
        )}
      </ol>
      {history.more && !folded && (filter === "all" || filter === "history") && (
        <button type="button" className="link small ticket-earlier" onClick={history.older}>
          Show older
        </button>
      )}
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
          <button type="submit" className="btn btn-sm ticket-composer-send" disabled={!draft.trim() || sending}>
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

/** A comment, and (Linear's) the replies to it, a level in. */
function CommentRow({
  comment: c,
  replies = [],
  ticket: t,
  me,
  person,
  small = false,
}: {
  comment: TicketComment;
  replies?: TicketComment[];
  ticket: Ticket;
  me: string | null | undefined;
  person: string | null | undefined;
  small?: boolean;
}) {
  const body = useKeyedBody(c.body, t.board);
  const behalf = onBehalfOf(c, t, person);
  // Posted there on the person's behalf, it's said so in place of where.
  const where = behalf ?? whereSaid(c) ?? (c.author.kind === "person" ? c.author.on : null);
  const mine = !!me && c.author.kind === "person" && c.author.name === me;
  return (
    <li className={`ticket-comment ticket-comment-${c.author.kind}${c.flagged ? " is-flagged" : ""}${small ? " is-reply" : ""}`}>
      <span className="ticket-comment-mark" aria-hidden="true">
        {markText(mine ? me.split(/\s+/)[0]! : c.author.name, c.author.kind === "agent")}
      </span>
      <div className="ticket-comment-main">
        <div className="ticket-comment-by">
          <b>{mine ? "You" : c.author.name}</b>
          {where && <span className={behalf ? "ticket-comment-behalf" : undefined}> · {where}</span>}
          <span> · </span>
          <time dateTime={c.at} title={dayClock(c.at)}>
            {dayText(c.at)}
          </time>
          {c.editedAt && <span> · edited</span>}
        </div>
        {c.flagged && <p className="small ticket-comment-flag">Reads as instructions to an AI: shown as written, never acted on.</p>}
        <div className="ticket-comment-body rich">
          <RichHostProvider host={COMMENT_HOST}>
            <RichMarkdown text={body} />
          </RichHostProvider>
        </div>
        {replies.length > 0 && (
          <ol className="ticket-replies">
            {replies.map((r) => (
              <CommentRow key={r.id} comment={r} ticket={t} me={me} person={person} small />
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}

/** Each board's ticket keys and ids, built once per change of the tickets
 *  and shared by every comment. */
const keysByBoard = new WeakMap<object, Map<string, Map<string, string>>>();
const boardKeys = (tickets: Record<string, Ticket>, board: string): Map<string, string> => {
  let boards = keysByBoard.get(tickets);
  if (!boards) keysByBoard.set(tickets, (boards = new Map()));
  let ids = boards.get(board);
  if (!ids) {
    ids = new Map();
    for (const o of Object.values(tickets)) {
      const key = o.board === board ? (o.external?.key ?? o.key) : null;
      if (key) ids.set(key, o.id);
    }
    boards.set(board, ids);
  }
  return ids;
};

/** A comment's text with each key of a ticket on the same board made a
 *  link to it, so it's drawn as that ticket's chip. */
function useKeyedBody(text: string, board: string): string {
  const tickets = useBoard((s) => s.tickets);
  return useMemo(() => {
    const ids = boardKeys(tickets, board);
    return ids.size ? linkTicketKeys(text, (k) => ids.get(k)) : text;
  }, [text, board, tickets]);
}

/** A row of history: who, what happened, when. */
function EventRow({ row, words, wide }: { row: Exclude<TimelineRow, { kind: "comment" }>; words: EventWords; wide: boolean }) {
  const parts = eventParts(row, words);
  return (
    <li className="ticket-ev">
      <span className="ticket-ev-tick" aria-hidden="true" />
      <span className="ticket-ev-text">
        {parts.map((p, i) => (
          <Fragment key={i}>{partOf(p, wide)}</Fragment>
        ))}
      </span>
      <time className="ticket-ev-at" dateTime={row.at} title={dayClock(row.at)}>
        {dayText(row.at)}
      </time>
    </li>
  );
}

const partOf = (p: Part, wide: boolean) => {
  if ("icon" in p) return p.icon === "merge" ? <MergeIcon /> : p.icon === "branch" ? <BranchIcon /> : <PrIcon />;
  switch (p.look) {
    case "b":
      return <b>{p.text}</b>;
    case "mono":
      return <span className="mono">{p.text}</span>;
    case "faint":
      return <span className="faint">{p.text}</span>;
    // Where it happened, said where there's room.
    case "on":
      return wide ? p.text : null;
    default:
      return p.text;
  }
};
