import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useSessionName } from "../groups/names";
import { SYSTEM_TITLE } from "../hub/boardSync";
import { useDesk } from "../hub/store";
import type { Board, Ticket, TicketChild, TicketLink, TicketState } from "../hub/types";
import { openUrl } from "../platform";
import { Mark } from "../ui/Mark";
import {
  BranchIcon,
  CheckIcon,
  CommitIcon,
  ExtIcon,
  LinkIcon,
  MergeIcon,
  PrChip,
  PrIcon,
  PriorityBars,
  prChip,
  ProjectIcon,
  StateGlyph,
  TypeGlyph,
  seriesColour,
  stateShape,
  type PrLook,
} from "./cardFacts";
import { useOpenTicket, useTicketPopup } from "./opener";
import { useBoard } from "./store";
import { TicketActivity } from "./TicketComments";
import {
  agoText,
  checksText,
  childColumn,
  childGroups,
  dayText,
  devOf,
  epicProgress,
  isEpic,
  prRows,
  type ChildGrouping,
  type EpicProgress as EpicProgressCount,
  type Layout,
  type PrRow,
} from "./ticketRich";

/** What a synced ticket's view draws of its issue beside its words: where
 *  it sits (team, epic or project, parent), its sub-items, its development,
 *  and what it's linked to. Each section is drawn only when there's
 *  something in it. */

/** Opens another issue by its key: in Desk when it's on a board here, else
 *  where it is. */
const useOpenIssue = (t: Ticket) => {
  const all = useBoard((s) => s.tickets);
  const openTicket = useOpenTicket();
  const here = (key: string) => Object.values(all).find((o) => o.external?.key === key || o.key === key);
  return {
    open: (key: string) => {
      const found = here(key);
      if (found) return openTicket(found.id);
      const url = remoteUrl(t, key);
      if (url) void openUrl(url);
    },
    /** Whether there's anywhere to open it: a board here, or an https address. */
    can: (key: string) => !!here(key) || !!remoteUrl(t, key),
  };
};

/** Issue `key`'s address, from `t`'s: the same site, its key in place. */
const remoteUrl = (t: Ticket, key: string): string | null => {
  const e = t.external;
  if (!e?.url || !/^https:\/\//i.test(e.url)) return null;
  const at = e.url.indexOf(e.key);
  return at < 0 ? null : e.url.slice(0, at) + key;
};

/** Whether a ticket on a board here has issue `key`. */
const useHere = (key: string | undefined) => useBoard((s) => (key ? Object.values(s.tickets).find((o) => o.external?.key === key) : undefined));

/** Where it sits: the team and board, its epic (Jira) or project (Linear),
 *  its parent; on Jira, itself. Each issue in it opens. */
export function Crumbs({ ticket: t, board, layout }: { ticket: Ticket; board: Board | undefined; layout: Layout }) {
  const issue = useOpenIssue(t);
  const parentHere = useHere(t.external?.details?.parent?.key);
  const e = t.external;
  const d = e?.details;
  const sync = board?.sync;
  if (!e || !sync) return null;
  const parent = d?.parent && d.parent.key !== d.epic?.key ? d.parent : undefined;
  const parentKind = parentHere?.external?.details?.stateKind;
  const team = layout === "compact" ? sync.target : `${sync.target} · ${board.name}`;
  return (
    <nav className="ticket-crumbs" aria-label="Where it sits">
      <span>{team}</span>
      {d?.epic && (
        <>
          <Sep />
          <button type="button" className="ticket-crumb" title={`Open ${d.epic.key}`} disabled={!issue.can(d.epic.key)} onClick={() => issue.open(d.epic!.key)}>
            <TypeGlyph kind={d.epic.kind ?? "Epic"} level={1} size={12} />
            <span className="mono ticket-crumb-key">{d.epic.key}</span>
            <span className="ticket-crumb-title">{d.epic.title}</span>
          </button>
        </>
      )}
      {d?.project && e.system === "linear" && (
        <>
          <Sep />
          <span className="ticket-crumb">
            <ProjectIcon />
            <span className="ticket-crumb-title">{d.project}</span>
          </span>
        </>
      )}
      {parent && (
        <>
          <Sep />
          <button type="button" className="ticket-crumb" title={`Open ${parent.key}`} disabled={!issue.can(parent.key)} onClick={() => issue.open(parent.key)}>
            {e.system === "linear" ? <StateGlyph kind={parentKind ?? stateKindOf(parent.state, parent.done)} name={parent.state} size={12} /> : <TypeGlyph kind={parent.kind} size={12} />}
            <span className="mono ticket-crumb-key">{parent.key}</span>
            <span className="ticket-crumb-title">{parent.title}</span>
          </button>
        </>
      )}
      {e.system === "jira" && layout !== "compact" && d?.kind && (
        <>
          <Sep />
          <span className="ticket-crumb ticket-crumb-self">
            <TypeGlyph kind={d.kind} level={d.kindLevel} size={12} />
            <span className="mono ticket-crumb-key">{e.key}</span>
          </span>
        </>
      )}
    </nav>
  );
}

const Sep = () => (
  <span className="ticket-crumb-sep" aria-hidden="true">
    ›
  </span>
);

/** A Linear state's type from its name, for an issue known only by it. */
const stateKindOf = (state: string | undefined, done: boolean | undefined): string | undefined => {
  if (done) return "completed";
  if (!state) return undefined;
  if (/progress|review|started/i.test(state)) return "started";
  if (/backlog|triage/i.test(state)) return "backlog";
  if (/cancel/i.test(state)) return "canceled";
  return "unstarted";
};

/** A section's head: its name, a note, and what sits at its right. */
export function SectionHead({ title, note, right }: { title: string; note?: ReactNode; right?: ReactNode }) {
  return (
    <div className="ticket-sec-head">
      <h2 className="ticket-section-head">{title}</h2>
      {note !== undefined && note !== null && <span className="ticket-sec-note">{note}</span>}
      {right && (
        <>
          <span className="ticket-sec-gap" />
          {right}
        </>
      )}
    </div>
  );
}

/** Who has an issue there, by name: their mark, or the empty ring. */
function Who({ name, me }: { name?: string; me?: string | null }) {
  if (!name)
    return <span className="board-upstream-ring ticket-row-who" title="No one has it" aria-label="Unassigned" />;
  return (
    <span className="ticket-row-who" title={me && name === me ? "You" : name}>
      <Mark name={name} size="xs" person />
    </span>
  );
}

/** A state's colour class, by what it says: done, under way, blocked,
 *  waiting in a backlog, or anything else. `started` and `stateKind` are a
 *  child's, where its issue says them. */
export const stateTone = (state: string | undefined, done?: boolean, { started, stateKind }: { started?: boolean; stateKind?: string } = {}): string => {
  const s = state ?? "";
  if (done || /^(done|closed|resolved|completed)$/i.test(s)) return "state-done";
  if (/blocked/i.test(s)) return "ticket-tone-blocked";
  if (started || /progress|review|doing/i.test(s)) return "ticket-tone-working";
  if (/backlog|triage/i.test(s) || stateKind === "backlog") return "ticket-tone-faint";
  return "muted";
};

/** Its sub-tasks (Jira) or sub-issues (Linear): how many are done, as a
 *  bar where there's room, and a row each. The shortest view lists those
 *  not done and folds the rest. */
export function SubItems({ ticket: t, layout }: { ticket: Ticket; layout: Layout }) {
  const [unfold, setUnfold] = useState(false);
  const issue = useOpenIssue(t);
  const me = useBoard((s) => s.boards[t.board]?.sync?.meName);
  const d = t.external?.details;
  const children = d?.children ?? [];
  if (!children.length || !t.external) return null;
  const done = d?.subItems?.done ?? children.filter((c) => c.done).length;
  const total = d?.subItems?.total ?? children.length;
  const started = d?.subItems?.started ?? children.filter((c) => c.started && !c.done).length;
  const compact = layout === "compact";
  const fold = compact && !unfold && children.some((c) => c.done);
  const rows = compact ? [...children.filter((c) => !c.done), ...(fold ? [] : children.filter((c) => c.done))] : children;
  const pct = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <section className="ticket-subitems" aria-label={t.external.system === "linear" ? "Sub-issues" : "Sub-items"}>
      <SectionHead
        title={t.external.system === "linear" ? "Sub-issues" : "Sub-items"}
        note={`${done} of ${total} done`}
        right={
          layout === "wide" && (
            <span className="ticket-bar" role="img" aria-label={`${done} done, ${started} under way, of ${total}`}>
              <i style={{ width: pct(done), background: "var(--done)" }} />
              <i style={{ width: pct(started), background: "var(--working)" }} />
            </span>
          )
        }
      />
      <div className="ticket-rows">
        {rows.map((c) => (
          <ChildRow key={c.key} child={c} me={me} who={!compact} onOpen={issue.can(c.key) ? () => issue.open(c.key) : undefined} />
        ))}
        {fold && (
          <button type="button" className="link small ticket-rows-more" onClick={() => setUnfold(true)}>
            {children.filter((c) => c.done).length} done
          </button>
        )}
      </div>
    </section>
  );
}

function ChildRow({ child: c, me, who, onOpen }: { child: TicketChild; me?: string | null; who: boolean; onOpen?: () => void }) {
  // Linear's state types draw the state; Jira's categories don't, so its
  // type leads and its state is said.
  const glyph = stateShape(c.stateKind, c.state);
  return (
    <button type="button" className="ticket-row" disabled={!onOpen} onClick={onOpen}>
      {glyph ? <StateGlyph kind={c.stateKind} name={c.state} /> : <TypeGlyph kind={c.kind ?? "Sub-task"} level={c.kindLevel ?? -1} />}
      <span className="mono ticket-row-key">{c.key}</span>
      <span className="ticket-row-title">{c.title}</span>
      {!glyph && c.state && <span className={`ticket-row-state ${stateTone(c.state, c.done)}`}>{c.state}</span>}
      {who && <Who name={c.assignee} me={me} />}
    </button>
  );
}

const DEV_TITLE = { jira: "Development", linear: "Diffs" } as const;
const DEV_FROM = { jira: "from Jira’s GitHub app", linear: "Linear’s GitHub link" } as const;

/** A PR's state as its chip draws it: a declined one as a faint dashed
 *  chip that says so. */
const lookOf = (state: PrRow["state"]): PrLook => (state === "declined" || !state ? "draft" : state);

/** Its pull requests (from its issue, and those its sessions linked, each
 *  once), then its branches and commits. */
export function Development({ ticket: t, layout }: { ticket: Ticket; layout: Layout }) {
  const dev = devOf(t);
  const rows = prRows(t, dev);
  const branches = dev?.branches ?? [];
  const commits = dev?.commits;
  if (!rows.length && !branches.length && !commits?.count) return null;
  const compact = layout === "compact";
  const system = t.external?.system;
  const ours = rows.some((r) => r.ours);
  const note = compact ? undefined : dev && system ? `${DEV_FROM[system]}${ours ? ", and Desk’s own sessions" : ""}` : ours ? "from Desk’s own sessions" : undefined;
  return (
    <section className="ticket-dev" aria-label="Development">
      <SectionHead title={system ? DEV_TITLE[system] : "Pull requests"} note={note} />
      <div className="ticket-rows">
        {rows.map((r) => (
          <PrRowView key={r.url} row={r} ticket={t} compact={compact} />
        ))}
        {!compact &&
          (branches.length ? branches : commits?.count ? [null] : []).map((b, i) => (
            <div key={b?.name ?? "commits"} className="ticket-row ticket-row-static">
              {b && <BranchIcon size={14} />}
              {b ? <span className="mono ticket-row-title ticket-branch">{b.name}</span> : <span className="ticket-row-title" />}
              {i === 0 && commits?.count ? (
                <span className="ticket-row-faint">
                  <CommitIcon />
                  {commits.count} commit{commits.count === 1 ? "" : "s"}
                  {commits.latest ? ` · ${agoText(commits.latest)}` : ""}
                </span>
              ) : null}
            </div>
          ))}
      </div>
    </section>
  );
}

function PrRowView({ row: r, ticket: t, compact }: { row: PrRow; ticket: Ticket; compact: boolean }) {
  const me = useBoard((s) => s.boards[t.board]?.sync?.meName);
  const opener = useOpener(t);
  const merged = r.state === "merged";
  return (
    <button type="button" className="ticket-row" title={r.url} onClick={() => void openUrl(r.url)}>
      {merged ? <MergeIcon size={14} /> : <PrIcon size={14} />}
      {r.number !== undefined && <span className="mono ticket-row-key">#{r.number}</span>}
      <span className="ticket-row-title">{r.title ?? r.url.replace(/^https?:\/\//, "")}</span>
      {!compact && r.checks && (
        <span className={`ticket-row-faint ticket-checks-${r.checks.state}`}>
          {r.checks.state === "pass" ? <CheckIcon /> : <i className="ticket-checks-dot" aria-hidden="true" />}
          {checksText(r.checks)}
        </span>
      )}
      {/* Short of room its checks ride on its chip, while they still matter: not once it's merged. */}
      {r.state && <PrChip look={lookOf(r.state)} text={r.state} checks={compact && !merged ? r.checks?.state : undefined} />}
      {!compact && (r.ours && opener ? <SessionName id={opener} /> : r.author ? <Person name={r.author} me={me} /> : null)}
    </button>
  );
}

/** The session that opened a ticket's PRs: the one working on it, else the
 *  only session linked to it. */
const useOpener = (t: Ticket): string | null => {
  if (t.assignee?.kind === "session") return t.assignee.id;
  const linked = t.links.flatMap((l) => (l.kind === "session" ? [l.session] : []));
  return linked.length === 1 ? linked[0]! : null;
};

/** A session by its name here, its dot in its state's colour. */
export function SessionName({ id }: { id: string }) {
  const session = useDesk((s) => s.sessions[id]);
  const name = useSessionName(id, session?.name ?? "");
  return (
    <span className="ticket-session">
      <span className={`dot dot-${session ? (session.state === "working" ? "working" : session.state) : "idle"}`} aria-hidden="true" />
      <span className="mono">{name || "a session"}</span>
    </span>
  );
}

/** A person there: their mark, and "You" for the person. */
export function Person({ name, me }: { name: string; me?: string | null }) {
  return (
    <span className="ticket-person">
      <Mark name={name} size="xs" person />
      {me && name === me ? "You" : name}
    </span>
  );
}

/** What it's linked to: issues it blocks or relates to there, pages, and
 *  the sessions and rooms Desk linked; read-only. What it's blocked by is
 *  one of its needs. */
export function LinkedWork({ ticket: t, working }: { ticket: Ticket; working: string | null }) {
  const issue = useOpenIssue(t);
  const issues = (t.external?.details?.links ?? []).filter((l) => l.rel !== "blockedBy");
  const pages = (devOf(t)?.links ?? []).filter((l) => l.words);
  const own = t.links.filter((l) => (l.kind === "session" && l.session !== working) || l.kind === "room");
  if (!issues.length && !pages.length && !own.length) return null;
  return (
    <section className="ticket-linked" aria-label="Linked work">
      <SectionHead title="Linked work" />
      <div className="ticket-rows">
        {issues.map((l) => (
          <button key={`${l.rel}:${l.issue.key}`} type="button" className="ticket-row" disabled={!issue.can(l.issue.key)} onClick={() => issue.open(l.issue.key)}>
            <span className="ticket-row-rel">{l.words ?? (l.rel === "blocks" ? "blocks" : "relates to")}</span>
            {l.issue.kind ? <TypeGlyph kind={l.issue.kind} /> : <LinkIcon size={14} />}
            <span className="mono ticket-row-key">{l.issue.key}</span>
            <span className="ticket-row-title">{l.issue.title}</span>
            {l.issue.state && <span className={`ticket-row-state ${stateTone(l.issue.state, l.issue.done)}`}>{l.issue.state}</span>}
          </button>
        ))}
        {pages.map((p) => (
          <button key={p.url} type="button" className="ticket-row" disabled={!/^https:\/\//i.test(p.url)} onClick={() => void openUrl(p.url)}>
            <span className="ticket-row-rel">{p.words}</span>
            <LinkIcon size={14} />
            <span className="ticket-row-title">{p.app ? `${p.app} · ${p.title}` : p.title}</span>
            <ExtIcon />
          </button>
        ))}
        {own.map((l) => (
          <OwnLink key={l.kind === "session" ? l.session : l.kind === "room" ? `${l.room}/${l.thread ?? ""}` : ""} link={l} />
        ))}
      </div>
    </section>
  );
}

/** A session or room Desk linked to the ticket: going to it leaves the
 *  popup. */
function OwnLink({ link: l }: { link: TicketLink }) {
  const session = useDesk((s) => (l.kind === "session" ? s.sessions[l.session] : undefined));
  const room = useDesk((s) => (l.kind === "room" ? s.rooms[l.room] : undefined));
  const popup = useTicketPopup();
  if (l.kind === "session")
    return (
      <button
        type="button"
        className="ticket-row"
        disabled={!session}
        onClick={() => {
          popup?.close();
          useDesk.getState().open(l.session);
        }}
      >
        <span className="ticket-row-rel">session</span>
        {session ? <SessionName id={l.session} /> : <span className="ticket-row-title faint">A session since forgotten</span>}
      </button>
    );
  if (l.kind === "room")
    return (
      <button
        type="button"
        className="ticket-row"
        disabled={!room}
        onClick={() => {
          popup?.close();
          void useDesk.getState().openRoom(l.room);
        }}
      >
        <span className="ticket-row-rel">room</span>
        <span className="ticket-row-title">
          {room ? `#${room.slug}` : "A room since deleted"}
          {l.thread ? " ▸ thread" : ""}
        </span>
      </button>
    );
  return null;
}

/** A dot in a name's series colour, and the name: a project. */
export function Dotted({ name }: { name: string }) {
  return (
    <span className="board-label ticket-dotted">
      <i style={{ background: seriesColour(name) }} aria-hidden="true" />
      {name}
    </span>
  );
}

export const systemWord = (t: Ticket): string | null => (t.external ? SYSTEM_TITLE[t.external.system] : null);

// ── An epic: its progress and its children ─────────────────────────────

/** Which Desk column each of an epic's children counts in: its own
 *  ticket's here, else by the board's states, else by its state's words. */
const useChildColumn = (t: Ticket): ((c: TicketChild) => TicketState) => {
  const all = useBoard((s) => s.tickets);
  const states = useBoard((s) => s.boards[t.board]?.sync?.states);
  return useMemo(() => {
    const here = new Map<string, TicketState>();
    for (const o of Object.values(all)) if (o.external?.key && o.external.system === t.external?.system) here.set(o.external.key, o.state);
    return (c: TicketChild) => childColumn(c, here.get(c.key), states ?? {});
  }, [all, states, t.external?.system]);
};

/** The site's priority names by rank, from its issues here: a child's
 *  bars say theirs in a tooltip. A child carries only its rank, so its name
 *  is inferred from another issue on the board at that rank; none there,
 *  the bars' own word (Urgent, High, Medium, Low). */
const usePriorityNames = (t: Ticket): Map<number, string> => {
  const all = useBoard((s) => s.tickets);
  return useMemo(() => {
    const names = new Map<number, string>();
    for (const o of Object.values(all)) {
      const d = o.external?.details;
      if (o.board === t.board && d?.priorityRank !== undefined && d.priority && !names.has(d.priorityRank)) names.set(d.priorityRank, d.priority);
    }
    return names;
  }, [all, t.board]);
};

/** An epic's progress by Desk's columns, the one count its byline, facts,
 *  list and bar all say; null for a ticket that isn't an epic. */
export const useEpicProgress = (t: Ticket): EpicProgressCount | null => {
  const columnOf = useChildColumn(t);
  const d = t.external?.details;
  return useMemo(() => (d && isEpic(t) ? epicProgress(d, columnOf) : null), [d, t, columnOf]);
};

/** How far an epic is: done of all its children by Desk's columns, its
 *  points, its due day, a bar of done, doing and review, and the rest, and
 *  how many children are blocked. */
export function EpicProgress({ ticket: t }: { ticket: Ticket }) {
  const p = useEpicProgress(t);
  const d = t.external?.details;
  if (!d || !p?.total) return null;
  const pct = (n: number) => `${(n / p.total) * 100}%`;
  return (
    <section className="ticket-epic-progress" aria-label="Progress">
      <div className="ticket-epic-line">
        <span className="ticket-epic-pct">{p.pct}%</span>
        <span className="muted">
          {p.done} of {p.total} done
          {p.points ? ` · ${p.points.done} of ${p.points.total} points` : ""}
        </span>
        {d.due && <span className="ticket-epic-due">due {dayText(d.due)}</span>}
      </div>
      <span className="ticket-bar ticket-bar-epic" role="img" aria-label={`${p.done} done, ${p.moving} in doing or review, ${p.rest} to do, of ${p.total}`}>
        {p.done > 0 && <i style={{ width: pct(p.done), background: "var(--done)" }} />}
        {p.moving > 0 && <i style={{ width: pct(p.moving), background: "var(--working)" }} />}
        {p.rest > 0 && <i style={{ width: pct(p.rest), background: "var(--border)" }} />}
      </span>
      <div className="ticket-epic-legend">
        <span>
          <i style={{ background: "var(--done)" }} aria-hidden="true" />
          Done {p.done}
        </span>
        <span>
          <i style={{ background: "var(--working)" }} aria-hidden="true" />
          Doing and review {p.moving}
        </span>
        <span>
          <i style={{ background: "var(--border)" }} aria-hidden="true" />
          To do and backlog {p.rest}
        </span>
        {!!p.blocked && <span className="state-blocked">{p.blocked} blocked</span>}
      </div>
    </section>
  );
}

const GROUPINGS: { id: ChildGrouping; word: string }[] = [
  { id: "none", word: "None" },
  { id: "state", word: "State" },
  { id: "assignee", word: "Assignee" },
  { id: "type", word: "Type" },
];

/** An epic's children as rows, grouped by state (or who has them, or
 *  type, or not at all), done ones folded after two or hidden. A child
 *  outside the board's filter lists here too: the hub searched for it. */
export function EpicChildren({ ticket: t }: { ticket: Ticket }) {
  const [by, setBy] = useState<ChildGrouping>("state");
  const [hideDone, setHideDone] = useState(false);
  const [unfold, setUnfold] = useState<ReadonlySet<string>>(new Set());
  const columnOf = useChildColumn(t);
  const progress = useEpicProgress(t);
  const names = usePriorityNames(t);
  const issue = useOpenIssue(t);
  const me = useBoard((s) => s.boards[t.board]?.sync?.meName);
  const d = t.external?.details;
  const children = d?.children ?? [];
  if (!children.length) return null;
  const groups = childGroups(children, columnOf, by, { hideDone, unfold });
  const finished = children.filter((c) => ["done", "dropped"].includes(columnOf(c))).length;
  return (
    <section className="ticket-epic-children" aria-label="Child items">
      <div className="ticket-sec-head ticket-epic-head">
        <h2 className="ticket-section-head">Child items</h2>
        <span className="ticket-sec-note">{progress?.total ?? children.length}</span>
        <span className="ticket-sec-gap" />
        <span className="ticket-epic-controls">
          <span className="ticket-epic-by" id={`group-by-${t.id}`}>
            Group by
          </span>
          <span className="ticket-filters" role="group" aria-labelledby={`group-by-${t.id}`}>
            {GROUPINGS.map((g) => (
              <button key={g.id} type="button" className="chip-btn" aria-pressed={by === g.id} onClick={() => setBy(g.id)}>
                {g.word}
              </button>
            ))}
          </span>
          <button type="button" className="chip-btn ticket-epic-hide" aria-pressed={hideDone} onClick={() => setHideDone(!hideDone)}>
            Hide done
          </button>
        </span>
      </div>
      <div className="ticket-rows">
        {groups.map((g) => (
          <div key={g.id} className="ticket-epic-group" role="group" aria-label={g.title ?? "Child items"}>
            {g.title !== null && (
              <h3 className="ticket-epic-group-head">
                {g.title}
                <span className="ticket-epic-group-n">
                  {g.count}
                  {g.points !== null ? ` · ${g.points} pts` : ""}
                </span>
              </h3>
            )}
            {g.rows.map((c) => (
              <EpicChildRow
                key={c.key}
                child={c}
                finished={["done", "dropped"].includes(columnOf(c))}
                priority={c.priorityRank !== undefined ? names.get(c.priorityRank) : undefined}
                me={me}
                onOpen={issue.can(c.key) ? () => issue.open(c.key) : undefined}
              />
            ))}
            {g.folded > 0 && (
              <button type="button" className="link ticket-epic-more" onClick={() => setUnfold(new Set([...unfold, g.id]))}>
                {g.folded} more done
              </button>
            )}
          </div>
        ))}
        {/* Done hidden, and nothing left: say so, not an empty list. */}
        {hideDone && finished === children.length && <p className="ticket-epic-all-done">All {finished} done</p>}
      </div>
    </section>
  );
}

function EpicChildRow({
  child: c,
  finished,
  priority,
  me,
  onOpen,
}: {
  child: TicketChild;
  finished: boolean;
  priority?: string;
  me?: string | null;
  onOpen?: () => void;
}) {
  const pr = c.prs ? prChip({ links: [] }, c.prs) : null;
  return (
    <button type="button" className="ticket-row ticket-epic-row" disabled={!onOpen} onClick={onOpen}>
      <TypeGlyph kind={c.kind ?? "Story"} level={c.kindLevel ?? 0} />
      <span className="mono ticket-row-key">{c.key}</span>
      <span className={`ticket-row-title${finished ? " ticket-row-title-done" : ""}`}>{c.title}</span>
      {/* Bars only: the site's name for it is its tooltip. Done, it no
          longer matters. Short of room, its PR, then its priority and
          points, give way to its title (board.css). */}
      {!finished && c.priorityRank !== undefined && (
        <span className="ticket-row-prio">
          <PriorityBars rank={c.priorityRank} name={priority} />
        </span>
      )}
      {c.points !== undefined && <span className="mono ticket-row-pts">{c.points} pts</span>}
      {pr && <PrChip look={pr.look} text={pr.text} title={pr.title} />}
      {c.state && <span className={`ticket-row-state ${stateTone(c.state, c.done, c)}`}>{c.state}</span>}
      <Who name={c.assignee} me={me} />
    </button>
  );
}

/** An epic's comments and history, folded in its details column; its
 *  timeline is the ticket's own, opened. */
export function ActivityFold({ ticket: t, layout }: { ticket: Ticket; layout: Layout }) {
  const [n, setN] = useState(0);
  const count = useCallback((k: number) => setN(k), []);
  return (
    <details className="ticket-activity-fold">
      <summary>Comments and history{n ? ` · ${n}` : ""}</summary>
      <TicketActivity ticket={t} layout={layout} onCount={count} />
    </details>
  );
}
