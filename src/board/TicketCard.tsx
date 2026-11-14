import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChargeBadge } from "../crew/ChargeBadge";
import { useCharge } from "../crew/chargeStore";
import { lookOf } from "../floor/background";
import { useSessionName } from "../groups/names";
import { useHubLayout } from "../groups/hubLayout";
import { askMove, ticketSubject } from "../groups/move";
import { Menu } from "../ui/Menu";
import { useDesk } from "../hub/store";
import type { ActivityParty, SyncAssignee, SyncSystem, Ticket } from "../hub/types";
import { useLocalAgent } from "../overview/people";
import { SYSTEM_TITLE, takeable } from "../hub/boardSync";
import { Mark } from "../ui/Mark";
import { blockers, needsLine } from "./board";
import {
  ClipIcon,
  CommentIcon,
  CycleIcon,
  GroupChip,
  IssueGlyph,
  LabelChip,
  LinkIcon,
  PrChip,
  PriorityBars,
  Ring,
  prChip,
  shortDate,
} from "./cardFacts";
import { useBoard } from "./store";
import type { TicketState } from "../hub/types";

/** Who has a ticket, as a card or the ticket's panel says it: their dot,
 *  their name, and that a boss runs them or that they wait on you. */
export function Assignee({ who, waiting, mark }: { who: ActivityParty; waiting: boolean; mark?: ReactNode }) {
  const session = useDesk((s) => (who.kind === "session" ? s.sessions[who.id] : undefined));
  const sessionName = useSessionName(who.kind === "session" ? who.id : null, who.name);
  const agent = useLocalAgent(who.kind === "agent" ? who.id : null);
  const charge = useCharge(who.kind === "session" ? who.id : null);
  const name = who.kind === "session" ? sessionName : who.kind === "agent" ? (agent?.name ?? who.name) : who.kind === "you" ? "You" : who.name;
  const look = session ? lookOf(session) : "idle";
  return (
    <span className="board-who">
      <span className={`dot dot-${look}`} aria-hidden="true" />
      <span className={who.kind === "session" ? "mono board-who-name" : "board-who-name"}>{name}</span>
      {mark}
      {waiting && session && (session.state === "blocked" || session.state === "asking") ? (
        <span className="state-blocked">{session.state === "asking" ? "asked you something" : "needs you"}</span>
      ) : (
        <ChargeBadge charge={charge} session={who.kind === "session" ? who.id : null} />
      )}
    </span>
  );
}

/** Who has a synced ticket's issue on Jira or Linear: their initials and
 *  name ("You" when it's the person), or Unassigned. */
export function Upstream({ who, me, system }: { who: SyncAssignee | null; me: string | null | undefined; system: SyncSystem }) {
  const title = SYSTEM_TITLE[system];
  if (!who)
    return (
      <span className="board-upstream board-upstream-none" title={`No one has it on ${title}`}>
        <span className="board-upstream-ring" aria-hidden="true" />
        Unassigned
      </span>
    );
  const you = !!me && who.id === me;
  return (
    <span className="board-upstream" title={`${you ? "You have" : `${who.name} has`} it on ${title}`}>
      <Mark name={who.name} size="xs" person tone="series" />
      <span className="board-upstream-name">{you ? "You" : who.name}</span>
    </span>
  );
}

/** Take it: the issue is assigned to the person there. */
export function TakeIt({ ticket, className = "btn btn-sm" }: { ticket: Ticket; className?: string }) {
  const [busy, setBusy] = useState(false);
  const fail = useDesk((s) => s.fail);
  const system = useBoard((s) => s.boards[ticket.board]?.sync?.system ?? null);
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      title={system ? `Assign ${ticket.key ?? "it"} to you on ${SYSTEM_TITLE[system]}` : undefined}
      aria-label={`Take ${ticket.key ?? "this ticket"}`}
      onClick={(e) => {
        e.stopPropagation();
        setBusy(true);
        useBoard
          .getState()
          .take(ticket.id)
          .catch(fail)
          .finally(() => setBusy(false));
      }}
    >
      {busy ? "Taking…" : "Take it"}
    </button>
  );
}

/** Who made a ticket that wasn't you, by their name here. */
const useMakerName = (who: ActivityParty): string => {
  const session = useSessionName(who.kind === "session" ? who.id : null, who.name);
  const agent = useLocalAgent(who.kind === "agent" ? who.id : null);
  return who.kind === "session" ? session : (agent?.name ?? who.name);
};

/** "acme-api added this", while it waits to be taken up. */
function Maker({ who }: { who: ActivityParty }) {
  return <span className="floor-item-what">{useMakerName(who)} added this</span>;
}

/** A quiet "by acme-api" once it's been taken up: its words stay theirs. */
function By({ who }: { who: ActivityParty }) {
  const name = useMakerName(who);
  return (
    <span className="board-by" title={`Written by ${name}`}>
      by {name}
    </span>
  );
}

/** One ticket on the board: its key, title, and what it waits on or who has
 *  it; drawn waiting when it waits on you, dashed while a session's or an
 *  agent's own, faint once settled. */
export function TicketCard({
  ticket: t,
  all,
  states,
  waiting,
  settled = false,
  plan,
  buttonRef,
  onOpen,
  onKeyDown,
}: {
  /** The goal of the boss's plan it is in, if it is in one. */
  plan?: string;
  ticket: Ticket;
  all: Readonly<Record<string, Ticket>>;
  /** Every ticket's state, worked out once for the board. */
  states: ReadonlyMap<string, TicketState>;
  waiting: boolean;
  settled?: boolean;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const board = useBoard((s) => s.boards[t.board]);
  const system = board?.sync?.system ?? null;
  const ext = t.external ?? null;
  // A synced ticket's maker is its board's Jira or Linear: every card would
  // say so, so none does.
  const written = t.createdBy.kind !== "you" && !ext;
  const theirs = written && t.state === "backlog" && !t.assignee;
  const blocked = (t.state === "todo" || t.state === "doing") && blockers(t, states).length > 0;
  const needs = needsLine(t, all, states);
  const facts = ext?.details;
  // What blocks its issue there that isn't a need here (the blocker isn't
  // on the board), while it isn't done.
  const remoteBlockers = (facts?.links ?? [])
    .filter((l) => l.rel === "blockedBy" && !l.issue.done && !t.needs.some((n) => all[n]?.key === l.issue.key))
    .map((l) => l.issue.key);
  const blockedLine =
    needs && !settled
      ? blocked
        ? needs.replace(/^needs/, "Blocked by")
        : needs
      : remoteBlockers.length && !settled && t.state !== "done" && t.state !== "dropped"
        ? `Blocked by ${remoteBlockers.join(", ")}`
        : null;
  // Drawn blocked as a need is: only while it is to do or being done.
  const blockedLook = blocked || (!needs && remoteBlockers.length > 0 && (t.state === "todo" || t.state === "doing"));
  // Being worked on: in Doing, its session working.
  const working = useDesk((s) => {
    const who = t.assignee;
    const session = who?.kind === "session" && t.state === "doing" ? s.sessions[who.id] : undefined;
    return session ? lookOf(session) === "working" : false;
  });
  const look = settled
    ? "board-card-settled"
    : waiting
      ? "board-card-waiting"
      : theirs
        ? "board-card-theirs"
        : working
          ? "board-card-working"
          : "";
  // Its right-click menu: moving it to another group's board.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const movable = useHubLayout((s) => s.layout !== null);
  // A synced board's ticket shows its issue's key; one made here waits for
  // its key until it is created there.
  const keyShown = t.key ?? (system ? `Not on ${SYSTEM_TITLE[system]} yet` : null);
  // Who has its issue there: shown once the hub has said (an older one
  // doesn't), and Take it while no one does.
  const upstream = system && ext && ext.assignee !== undefined && !settled ? ext.assignee : undefined;
  const canTake = !settled && takeable(board, t);
  // The epic (Jira) or project (Linear) it belongs to, in its head.
  const group = facts?.epic
    ? { name: facts.epic.title || facts.epic.key, title: `Epic ${facts.epic.key} · ${facts.epic.title}` }
    : facts?.project
      ? { name: facts.project, title: `Project · ${facts.project}` }
      : null;
  // One meta row, in a fixed order: priority, labels (Linear's), points,
  // sub-items, the PR. A finished card keeps only its PR.
  const pr = prChip(t, facts?.prs);
  const labels = system === "linear" ? (facts?.labels ?? []) : [];
  const points = facts?.points;
  const sub = facts?.subItems;
  const meta = [
    !settled && facts?.priorityRank ? <PriorityBars key="prio" rank={facts.priorityRank} name={facts.priority} /> : null,
    ...(!settled ? labels.slice(0, 2).map((l) => <LabelChip key={`l:${l}`} name={l} />) : []),
    !settled && labels.length > 2 ? (
      <span key="more" className="board-label" title={labels.slice(2).join(", ")}>
        +{labels.length - 2}
      </span>
    ) : null,
    !settled && points !== undefined ? (
      <span key="pts" className="board-pts" title={`${points} point${points === 1 ? "" : "s"}`}>
        {points} pts
      </span>
    ) : null,
    !settled && sub && sub.total > 0 ? (
      <span key="subs" className="board-subs" title={`${sub.done} of ${sub.total} sub-items done`}>
        <Ring done={sub.done} total={sub.total} />
        {sub.done}/{sub.total}
      </span>
    ) : null,
    pr ? <PrChip key="pr" look={pr.look} text={pr.text} title={pr.title} /> : null,
  ].filter((x) => x !== null);
  // At its foot, on hover or focus: comments, files, what it blocks, and
  // Linear's cycle; Linear's created date while not.
  const blocks = (facts?.links ?? []).filter((l) => l.rel === "blocks");
  const files = t.files?.length ?? 0;
  const comments = facts?.comments ?? 0;
  const cycle = system === "linear" && facts?.sprint ? (facts.sprint.name ?? (facts.sprint.number !== undefined ? `Cycle ${facts.sprint.number}` : null)) : null;
  const more =
    ext && !settled && (blocks.length > 0 || files > 0 || comments > 0 || cycle) ? (
      <span className="board-counts">
        {cycle && (
          <span>
            <CycleIcon />
            {cycle}
          </span>
        )}
        {blocks.length > 0 && (
          <span title={`Blocks ${blocks.map((l) => l.issue.key).join(", ")}`}>
            <LinkIcon />
            {blocks.length}
          </span>
        )}
        {comments > 0 && (
          <span title={`${comments} comment${comments === 1 ? "" : "s"}`}>
            <CommentIcon />
            {comments}
          </span>
        )}
        {files > 0 && (
          <span title={`${files} file${files === 1 ? "" : "s"}`}>
            <ClipIcon />
            {files}
          </span>
        )}
      </span>
    ) : null;
  const when = system === "linear" && facts?.created && !settled && !canTake ? shortDate(facts.created) : "";
  // Who has it: a Desk session first, with whom its issue's assignee is
  // there beside it, else the assignee there.
  const there = upstream ? (
    <span className="board-upstream-also" title={`${upstream.id === board?.sync?.me ? "You have" : `${upstream.name} has`} it on ${SYSTEM_TITLE[system!]}`}>
      <Mark name={upstream.name} size="xs" person tone="series" />
    </span>
  ) : null;
  const who =
    t.assignee && !settled ? (
      <Assignee who={t.assignee} waiting={waiting} mark={there} />
    ) : upstream !== undefined && system ? (
      <Upstream who={upstream} me={board?.sync?.me} system={system} />
    ) : null;
  const foot = who || more || when;
  // What its glyphs and chips say, for a screen reader: the button's label
  // is its key and title only.
  const descId = useId();
  const said = facts
    ? [
        facts.kind ?? facts.remoteState,
        facts.epic ? `Epic ${facts.epic.title || facts.epic.key}` : facts.project ? `Project ${facts.project}` : null,
        !settled && facts.priorityRank ? `Priority ${facts.priority ?? ["Urgent", "High", "Medium", "Low"][facts.priorityRank - 1] ?? ""}` : null,
        !settled && labels.length ? `Labels ${labels.join(", ")}` : null,
        !settled && points !== undefined ? `${points} point${points === 1 ? "" : "s"}` : null,
        !settled && sub && sub.total > 0 ? `${sub.done} of ${sub.total} sub-items done` : null,
        pr?.title ?? null,
        blockedLine,
      ]
        .filter(Boolean)
        .join(". ")
    : "";
  return (
    <div className={canTake ? "board-card-wrap board-card-wrap-take" : "board-card-wrap"}>
    <button
      ref={buttonRef}
      type="button"
      data-ticket-card={t.id}
      className={`floor-item board-card ${look}`}
      onContextMenu={
        movable || canTake
          ? (e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY });
            }
          : undefined
      }
      aria-label={`${t.key ?? "Ticket"}: ${t.title}`}
      aria-roledescription="ticket"
      aria-describedby={said ? descId : undefined}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
      title={t.state === "dropped" ? "Dropped" : undefined}
      onClick={onOpen}
      onKeyDown={onKeyDown}
    >
      <span className={ext ? "board-card-head board-card-head-synced" : "board-card-head"}>
        <IssueGlyph details={facts} />
        <span className={t.key ? "mono board-key" : "board-key"} title={ext ? `${SYSTEM_TITLE[ext.system]} issue ${ext.key}${ext.synced ? "" : ", no longer synced"}` : undefined}>
          {keyShown}
        </span>
        {t.pinned && <span className="board-pinned">Pinned</span>}
        {t.state === "dropped" && !facts?.stateKind && <span className="faint small board-dropped">Dropped</span>}
        {written && !theirs && <By who={t.createdBy} />}
        {plan !== undefined && (
          <span className="chip board-plan-chip" title={plan ? `In the plan “${plan}”` : "In a plan"}>
            {plan || "Plan"}
          </span>
        )}
        {group && <GroupChip name={group.name} title={group.title} />}
      </span>
      <b className="board-title">{t.title}</b>
      {said && (
        <span id={descId} className="sr-only">
          {said}
        </span>
      )}
      {meta.length > 0 && <span className="board-card-meta board-card-facts">{meta}</span>}
      {blockedLine && <span className={blockedLook ? "floor-item-what state-blocked" : "floor-item-what"}>{blockedLine}</span>}
      {theirs && <Maker who={t.createdBy} />}
      {t.pushProblem && !settled && <span className="floor-item-what state-blocked board-push-problem">{t.pushProblem}</span>}
      {foot && (
        <span className="board-card-foot">
          {who}
          {more}
          {when && <span className="board-when">{when}</span>}
        </span>
      )}
    </button>
      {canTake && <TakeIt ticket={t} className="btn btn-sm board-take" />}
      {menu && (
        <Menu
          label={`${t.key ?? "Ticket"} options`}
          at={menu}
          entries={[
            ...(canTake ? [{ kind: "item" as const, label: "Take it", onSelect: () => void useBoard.getState().take(t.id).catch(useDesk.getState().fail) }] : []),
            ...(movable ? [{ kind: "item" as const, label: "Move to group…", onSelect: () => askMove(ticketSubject(t)) }] : []),
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
