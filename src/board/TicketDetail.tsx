import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { useSessionName, useSessionNames } from "../groups/names";
import { below } from "../groups/rows";
import { useHubLayout } from "../groups/hubLayout";
import { askMove, ticketSubject } from "../groups/move";
import { deskListeners, sortedSessions, useDesk, localSessions } from "../hub/store";
import type { ActivityEvent, ActivityParty, DeskEvent, Ticket, TicketLink, TicketState } from "../hub/types";
import { SidePanel } from "../panels/Stage";
import { openUrl } from "../platform";
import { ticketLink } from "../shell/links";
import { tokensText, usdText } from "../spend/spend";
import { Confirm } from "../ui/Confirm";
import { Menu, type MenuEntry } from "../ui/Menu";
import { plainError } from "../ui/plainError";
import { clock, dayClock } from "../floor/time";
import { mergeEvents } from "../overview/activity";
import { STATE_TITLE, historyLine, sessionsOf, spendOf } from "./board";
import { useWaiting } from "./BoardView";
import { StartSession } from "./StartSession";
import { TicketBody } from "./TicketBody";
import { TicketComments } from "./TicketComments";
import { TicketFiles, useUploads } from "./TicketFiles";
import { localTicketView } from "./ticketView";
import { useBoard } from "./store";
import { Assignee, TakeIt, Upstream } from "./TicketCard";
import { issueUrl, SYSTEM_TITLE, takeable } from "../hub/boardSync";

const STATES: TicketState[] = ["backlog", "todo", "doing", "review", "done", "dropped"];

const HOUR = 60 * 60 * 1000;

/** Snooze's choices: an hour, until tomorrow morning, a week. */
const snoozeChoices = (now: Date): { label: string; until: Date }[] => {
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(9, 0, 0, 0);
  return [
    { label: "For an hour", until: new Date(now.getTime() + HOUR) },
    { label: "Until tomorrow morning", until: morning },
    { label: "For a week", until: new Date(now.getTime() + 7 * 24 * HOUR) },
  ];
};

/** The most ledger pages read for a ticket's spend. */
const SPEND_PAGES = 10;

/** How often a ticket's spend is read again while its panel is open. */
export const SPEND_EVERY_MS = 60_000;

/** What a ticket's sessions spent on it this month, from the ledger's rows
 *  stamped with it, read again each minute while it's open; null until
 *  read, or where the hub has no ledger. `capped`: a session had more pages
 *  than were read, so it's at least this. */
const useTicketSpend = (t: Ticket): Spend | null => {
  const hub = useDesk((s) => s.hub);
  const sessions = sessionsOf(t).join(" ");
  const [spend, setSpend] = useState<Spend | null>(null);
  useEffect(() => {
    if (!hub || !sessions) return setSpend(null);
    let live = true;
    const read = async () => {
      const rows = [];
      let capped = false;
      try {
        for (const session of sessions.split(" ")) {
          let before: string | undefined;
          for (let page = 0; ; page++) {
            if (page === SPEND_PAGES) {
              capped = true;
              break;
            }
            const p = await hub.ledger({ period: "month", session, before });
            rows.push(...p.rows);
            if (!p.next) break;
            before = p.next;
          }
        }
        if (live) setSpend({ ...spendOf(rows, t.id), capped });
      } catch {
        if (live) setSpend(null);
      }
    };
    void read();
    const every = setInterval(() => void read(), SPEND_EVERY_MS);
    return () => {
      live = false;
      clearInterval(every);
    };
  }, [hub, sessions, t.id]);
  return spend;
};

type Spend = { tokens: number; usd: number; calls: number; capped: boolean };

/** A ticket's history, newest last as it happened; the next page older. */
const useTicketHistory = (t: Ticket): { events: ActivityEvent[]; more: boolean; older: () => void; problem: string | null } => {
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
  // What happens to it meanwhile, as it happens.
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

/** The ticket open in its panel, kept current; the panel closes once it's
 *  gone. */
export function OpenTicket() {
  const id = useBoard((s) => s.open);
  const t = useBoard((s) => (s.open ? s.tickets[s.open] : undefined));
  const supported = useBoard((s) => s.supported);
  const hub = useDesk((s) => s.hub);
  // Opened from a chip before the board was read: ask for it.
  useEffect(() => {
    if (!id || t || !hub || supported === false) return;
    useBoard
      .getState()
      .fetched(id)
      .catch(() => useBoard.getState().openTicket(null));
  }, [id, t, hub, supported]);
  return t ? <TicketDetail key={t.id} ticket={t} /> : null;
}

/** A ticket beside the board: its state and who has it, what to do with
 *  it, what it needs and is needed by, its links, and its history with
 *  what it cost. */
export function TicketDetail({ ticket: t }: { ticket: Ticket }) {
  const all = useBoard((s) => s.tickets);
  const sessions = useDesk((s) => localSessions(s.sessions));
  const waiting = useWaiting()(t);
  const [menu, setMenu] = useState<{ kind: "hand" | "snooze"; at: { x: number; y: number }; from: HTMLElement | null } | null>(null);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState<"title" | "body" | null>(null);
  const [draft, setDraft] = useState("");
  /** What the field said when it was opened. */
  const [base, setBase] = useState("");
  /** An edit made over a change heard meanwhile: the person's, and the
   *  ticket's as it now is, for them to choose between. */
  const [conflict, setConflict] = useState<{ field: "title" | "body"; mine: string; theirs: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const handEntries = useHandEntries(t);
  const spend = useTicketSpend(t);
  const history = useTicketHistory(t);
  const movable = useHubLayout((s) => s.layout !== null);
  const names = useSessionNames();
  const roster = useChat((s) => s.roster);
  const store = useBoard.getState;

  const act = (p: Promise<void>) => {
    setProblem(null);
    p.catch((e) => setProblem(plainError(e)));
  };
  const session = t.assignee?.kind === "session" ? sessions[t.assignee.id] : undefined;
  const board = useBoard((s) => s.boards[t.board]);
  const sync = board?.sync ?? null;
  const canTake = takeable(board, t);
  const neededBy = useMemo(() => Object.values(all).filter((o) => o.needs.includes(t.id)), [all, t.id]);
  const save = () => {
    const field = editing;
    setEditing(null);
    if (!field) return;
    const value = field === "title" ? draft.trim() : draft;
    if ((field === "title" && !value) || value === t[field]) return;
    if (t[field] !== base) return setConflict({ field, mine: value, theirs: t[field] });
    act(store().edit(t.id, { [field]: value }));
  };
  const startEditing = (field: "title" | "body") => {
    setConflict(null);
    setDraft(t[field]);
    setBase(t[field]);
    setEditing(field);
  };
  const snoozeEntries: MenuEntry[] = [
    ...snoozeChoices(new Date()).map((c) => ({ kind: "item" as const, label: c.label, onSelect: () => act(store().edit(t.id, { snoozedUntil: c.until.toISOString() })) })),
    ...(t.snoozedUntil ? [{ kind: "separator" as const }, { kind: "item" as const, label: "Wake it now", onSelect: () => act(store().edit(t.id, { snoozedUntil: null })) }] : []),
  ];
  const agentName = (id: string) => roster.find((a) => a.id === id)?.name;
  const local = !t.external && !sync;
  const uploads = useUploads(t, setProblem);
  const [dropping, setDropping] = useState(false);
  const issue = t.external ? issueUrl(t) : null;
  const details = t.external?.details;
  const labels = details?.labels?.length ? details.labels : null;
  // A synced ticket's issue is read whole for its files when it opens, now
  // and then: what the pull doesn't bring (a file attached since).
  useEffect(() => {
    if (!t.external?.synced) return;
    localTicketView()
      ?.readIssue(t.id)
      .then((v) => useBoard.getState().heard(v))
      .catch(() => {});
  }, [t.id, t.external?.synced]);
  return (
    <SidePanel
      className="ticket-panel"
      label={`Ticket ${t.key ?? t.title}`}
      noun="this ticket"
      onClose={() => store().openTicket(null)}
      title={
        <>
          {t.key && <span className="chip ticket-key">{t.key}</span>}
          {issue && t.external && (
            <button type="button" className="link small ticket-open-issue" aria-label={`Open in ${SYSTEM_TITLE[t.external.system]}`} onClick={() => openUrl(issue)}>
              Open in {SYSTEM_TITLE[t.external.system]} ↗
            </button>
          )}
          <span className="rpanel-name" />
        </>
      }
      actions={
        <>
          <button type="button" className="chip-btn" aria-pressed={t.pinned} onClick={() => act(store().edit(t.id, { pinned: !t.pinned }))}>
            {t.pinned ? "Pinned" : "Pin"}
          </button>
          <button
            type="button"
            className="chip-btn"
            aria-pressed={t.snoozed}
            aria-haspopup="menu"
            title={t.snoozedUntil ? `Snoozed until ${dayClock(t.snoozedUntil)}` : "Hide it from the board for a while"}
            onClick={(e) => setMenu({ kind: "snooze", at: below(e.currentTarget), from: e.currentTarget })}
          >
            {t.snoozed && t.snoozedUntil ? `Snoozed till ${dayClock(t.snoozedUntil)}` : "Snooze"}
          </button>
        </>
      }
    >
      <div className="ticket-body ticket-view">
        <div
          className={`ticket-read${dropping ? " is-dropping" : ""}`}
          onDragOver={(e) => {
            if (!local || ![...e.dataTransfer.types].includes("Files")) return;
            e.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
          }}
          onDrop={(e) => {
            if (!local || !e.dataTransfer.files.length) return;
            e.preventDefault();
            setDropping(false);
            void uploads.add([...e.dataTransfer.files]);
          }}
        >
          {editing === "title" ? (
            <input
              className="ticket-title-edit display"
              autoFocus
              aria-label="Title"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                else if (e.key === "Escape") {
                  e.stopPropagation();
                  setEditing(null);
                }
              }}
            />
          ) : (
            <h1 className="ticket-title display">
              <button type="button" className="ticket-edit" title="Change the title" onClick={() => startEditing("title")}>
                {t.title}
              </button>
            </h1>
          )}
          {t.createdBy.kind !== "you" && <WrittenBy who={t.createdBy} />}
          {t.external && !t.external.synced && <IssueLine ticket={t} />}
          {t.pushProblem && (
            <p className="small state-blocked ticket-push-problem" role="status">
              {t.pushProblem}
            </p>
          )}
          {conflict && (
            <div className="ticket-conflict" role="alert">
              <p className="small state-blocked">Changed meanwhile. The {conflict.field === "title" ? "title" : "description"} now says:</p>
              <p className="ticket-text muted">{conflict.theirs || "(nothing)"}</p>
              <div className="ticket-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    act(store().edit(t.id, { [conflict.field]: conflict.mine }));
                    setConflict(null);
                  }}
                >
                  Keep mine
                </button>
                <button type="button" className="link" onClick={() => setConflict(null)}>
                  Take the new one
                </button>
              </div>
            </div>
          )}
          {problem && (
            <p className="small state-blocked" role="alert">
              {problem}
            </p>
          )}
          <article className="ticket-description" aria-label="Description">
            {editing === "body" ? (
              <textarea
                className="board-textarea"
                autoFocus
                aria-label="What it's about"
                rows={8}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={save}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditing(null);
                  }
                }}
              />
            ) : t.body ? (
              <TicketBody text={t.body} onEdit={() => startEditing("body")} />
            ) : (
              <button type="button" className="ticket-edit ticket-text" title="Change what it's about" onClick={() => startEditing("body")}>
                <span className="faint">Add what it's about, and what done looks like</span>
              </button>
            )}
          </article>
          <TicketFiles ticket={t} local={local} uploads={uploads} />
          <TicketComments ticket={t} />
        </div>
        <aside className="ticket-side" aria-label="Details">
          <div className="ticket-side-acts">
            {canTake && <TakeIt ticket={t} className="btn btn-signal ticket-take" />}
            {session && (
              <button type="button" className="btn ticket-take" onClick={() => useDesk.getState().open(session.id)}>
                Go to session
              </button>
            )}
            <div className="ticket-side-pair">
              <button type="button" className="btn btn-sm" onClick={() => setStarting(true)}>
                Start a session
              </button>
              <button type="button" className="btn btn-sm" aria-haspopup="menu" onClick={(e) => setMenu({ kind: "hand", at: below(e.currentTarget), from: e.currentTarget })}>
                Hand to…
              </button>
            </div>
          </div>
          <dl className="ticket-facts">
            <dt>
              <label htmlFor={`ticket-state-${t.id}`}>State</label>
            </dt>
            <dd>
              <select id={`ticket-state-${t.id}`} className="board-select" value={t.state} onChange={(e) => act(store().move(t.id, { state: e.target.value as TicketState }))}>
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {STATE_TITLE[s]}
                  </option>
                ))}
              </select>
            </dd>
            <dt>Assignee</dt>
            <dd>{t.assignee ? <Assignee who={t.assignee} waiting={waiting} /> : <span className="muted">Unassigned</span>}</dd>
            {sync && t.external && t.external.assignee !== undefined && (
              <>
                <dt>On {SYSTEM_TITLE[sync.system]}</dt>
                <dd>
                  <Upstream who={t.external.assignee} me={sync.me} system={sync.system} />
                </dd>
              </>
            )}
            {details?.priority && (
              <>
                <dt>Priority</dt>
                <dd>{details.priority}</dd>
              </>
            )}
            {labels && (
              <>
                <dt>Labels</dt>
                <dd className="ticket-labels">
                  {labels.map((l) => (
                    <span key={l} className="ticket-label">
                      {l}
                    </span>
                  ))}
                </dd>
              </>
            )}
            {details?.project && (
              <>
                <dt>Project</dt>
                <dd>{details.project}</dd>
              </>
            )}
            {details?.due && (
              <>
                <dt>Due</dt>
                <dd>{dueText(details.due)}</dd>
              </>
            )}
          </dl>
          <Needs ticket={t} neededBy={neededBy} onProblem={setProblem} />
          <Links links={t.links} />
          <section aria-label="History">
          <details className="ticket-history">
            <summary className="ticket-history-head">
              History · {history.events.length}
              {history.more ? "+" : ""}
              {spend && spend.calls > 0 && (
                <span className="floor-time" title="What its sessions spent on it this month, at API prices">
                  {spend.capped ? "at least " : ""}
                  {tokensText(spend.tokens)} tokens · {usdText(spend.usd)} this month
                </span>
              )}
            </summary>
            {history.problem && <p className="small state-blocked">{history.problem}</p>}
            <ol className="ticket-history-rows">
              {[...history.events].reverse().map((e) => (
                <HistoryRow key={e.id} event={e} ticketKey={t.key} names={names} agentName={agentName} />
              ))}
            </ol>
            {history.more && (
              <button type="button" className="link small" onClick={history.older}>
                Show older
              </button>
            )}
          </details>
          </section>
          <div className="ticket-foot">
            <button
              type="button"
              className="link small"
              title="A link that opens this ticket, to paste in a room"
              onClick={() =>
                void navigator.clipboard
                  .writeText(ticketLink(t.id))
                  .then(() => setProblem(null))
                  .catch(() => setProblem("Couldn't copy the link."))
              }
            >
              Copy link
            </button>
            {movable && (
              <button type="button" className="link small" onClick={() => askMove(ticketSubject(t))}>
                Move to group…
              </button>
            )}
            {t.state === "dropped" ? (
              <button type="button" className="link small" onClick={() => act(store().move(t.id, { state: "backlog" }))}>
                Bring it back
              </button>
            ) : (
              <button type="button" className="link small" onClick={() => act(store().move(t.id, { state: "dropped" }))}>
                Drop
              </button>
            )}
            <button type="button" className="link small" onClick={() => setDeleting(true)}>
              Delete…
            </button>
          </div>
        </aside>
      </div>
      {menu && (
        <Menu
          label={menu.kind === "hand" ? "Hand it to" : "Snooze"}
          at={menu.at}
          entries={menu.kind === "hand" ? handEntries : snoozeEntries}
          onClose={(refocus) => {
            if (refocus) menu.from?.focus();
            setMenu(null);
          }}
        />
      )}
      {starting && <StartSession ticket={t} onClose={() => setStarting(false)} />}
      {deleting && (
        <Confirm title={`Delete ${t.key ?? "this ticket"}?`} action="Delete ticket" onConfirm={() => store().remove(t.id)} onClose={() => setDeleting(false)}>
          <p className="muted">{t.assignee ? `${t.assignee.name} is told it's gone. ` : ""}Its history stays with the sessions that worked on it.</p>
        </Confirm>
      )}
    </SidePanel>
  );
}

/** A due date as the details say it: "Fri 14 Nov". */
export const dueText = (due: string): string => {
  const d = new Date(`${due}T12:00:00`);
  return Number.isNaN(d.getTime()) ? due : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
};

/** Who wrote a ticket that wasn't the person: its words are theirs. */
function WrittenBy({ who }: { who: ActivityParty }) {
  const session = useSessionName(who.kind === "session" ? who.id : null, who.name);
  const agent = useChat((s) => (who.kind === "agent" ? s.roster.find((a) => a.id === who.id)?.name : undefined));
  const name = who.kind === "session" ? session : (agent ?? who.name);
  return (
    <p className="faint small ticket-by">
      Written by <span className={who.kind === "session" ? "mono" : undefined}>{name}</span>: its title and description are its words, not yours.
    </p>
  );
}

/** Whom it can go to: the sessions running, the agents on this computer,
 *  and taking it off whoever has it. */
const useHandEntries = (t: Ticket): MenuEntry[] => {
  const sessions = sortedSessions(useDesk((s) => localSessions(s.sessions))).filter((s) => s.live);
  const names = useSessionNames();
  const local = useChat((s) => s.hubs.find((h) => h.local)?.id);
  const roster = useChat((s) => s.roster);
  const agents = useMemo(() => roster.filter((a) => a.hubId === local), [roster, local]);
  const fail = useDesk((s) => s.fail);
  const give = (to: Parameters<ReturnType<typeof useBoard.getState>["assign"]>[1]) => void useBoard.getState().assign(t.id, to).catch(fail);
  const mine = (kind: string, id: string) => t.assignee?.kind === kind && t.assignee.id === id;
  return [
    ...(sessions.length
      ? sessions.map((s) => ({ kind: "item" as const, label: names[s.id] ?? s.displayName ?? s.name, checked: mine("session", s.id), onSelect: () => give({ session: s.id }) }))
      : [{ kind: "item" as const, label: "No sessions are running" }]),
    ...(agents.length ? [{ kind: "separator" as const }] : []),
    ...agents.map((a) => ({ kind: "item" as const, label: a.name, checked: mine("agent", a.id), onSelect: () => give({ agent: a.id }) })),
    ...(t.assignee ? [{ kind: "separator" as const }, { kind: "item" as const, label: `Take it off ${t.assignee.kind === "you" ? "you" : t.assignee.name}`, onSelect: () => give(null) }] : []),
  ];
};

/** One row of a ticket's history: when, who, what happened to it; a note
 *  a session or an agent left, quoted as theirs. */
function HistoryRow({
  event: e,
  ticketKey,
  names,
  agentName,
}: {
  event: ActivityEvent;
  ticketKey: string | null;
  names: Readonly<Record<string, string>>;
  agentName: (id: string) => string | undefined;
}) {
  const line = historyLine(e, ticketKey);
  const who = e.actor.kind === "you" ? "You" : e.actor.kind === "session" ? (names[e.actor.id] ?? e.actor.name) : e.actor.kind === "agent" ? (agentName(e.actor.id) ?? e.actor.name) : e.actor.name;
  return (
    <li className="ticket-history-row">
      <time className="floor-time" dateTime={e.at} title={dayClock(e.at)}>
        {clock(e.at)}
      </time>
      <span>
        <span className={e.actor.kind === "session" ? "mono" : undefined}>{who}</span> {line.text}
        {line.quote !== null && <span className="muted"> “{line.quote}”</span>}
      </span>
    </li>
  );
}

/** What it needs done first, and what needs it; a need added by its key
 *  or words, or taken off. */
function Needs({ ticket: t, neededBy, onProblem }: { ticket: Ticket; neededBy: Ticket[]; onProblem: (p: string | null) => void }) {
  const all = useBoard((s) => s.tickets);
  const hub = useDesk((s) => s.hub);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Ticket[]>([]);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!adding || !hub || !q.trim()) return setFound([]);
    let live = true;
    const wait = setTimeout(() => {
      hub
        .searchTickets(q.trim())
        .then((got) => live && setFound(got.filter((o) => o.id !== t.id && !t.needs.includes(o.id))))
        .catch(() => live && setFound([]));
    }, 150);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [adding, hub, q, t.id, t.needs]);
  const need = (other: string, needs: boolean) => {
    onProblem(null);
    useBoard
      .getState()
      .need(t.id, other, needs)
      .then(() => {
        setAdding(false);
        setQ("");
      })
      .catch((e) => onProblem(plainError(e)));
  };
  const needs = t.needs.map((id) => all[id]).filter((o): o is Ticket => !!o);
  return (
    <section className="ticket-needs" aria-label="Needs">
      <h3 className="ov-label muted">Needs</h3>
      {needs.map((o) => (
        <NeedRow key={o.id} ticket={o} onRemove={() => need(o.id, false)} />
      ))}
      {adding ? (
        <div className="ticket-need-add">
          <input
            ref={field}
            autoFocus
            className="board-search"
            aria-label="A ticket it needs"
            placeholder="Its key or words"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setAdding(false);
              } else if (e.key === "Enter" && found[0]) need(found[0].id, true);
            }}
          />
          {found.map((o) => (
            <button key={o.id} type="button" className="ticket-need ticket-need-pick" onClick={() => need(o.id, true)}>
              <span className="mono board-key">{o.key}</span>
              <span className="ticket-need-title">{o.title}</span>
              <span className="small faint">{STATE_TITLE[o.state]}</span>
            </button>
          ))}
        </div>
      ) : (
        <button type="button" className="link small ticket-need-more" onClick={() => setAdding(true)}>
          {needs.length ? "Add another need…" : "Add a ticket it needs first…"}
        </button>
      )}
      {neededBy.length > 0 && (
        <>
          <h3 className="ov-label muted ticket-needed-by">Needed by</h3>
          {neededBy.map((o) => (
            <NeedRow key={o.id} ticket={o} />
          ))}
        </>
      )}
    </section>
  );
}

function NeedRow({ ticket: o, onRemove }: { ticket: Ticket; onRemove?: () => void }) {
  return (
    <div className="ticket-need">
      <button type="button" className="ticket-need-open" onClick={() => useBoard.getState().openTicket(o.id)}>
        <span className="mono board-key">{o.key}</span>
        <span className="ticket-need-title">{o.title}</span>
        <span className={`small ${o.state === "done" ? "state-done" : "faint"}`}>{STATE_TITLE[o.state]}</span>
      </button>
      {onRemove && (
        <button type="button" className="icon-btn-sm" aria-label={`It no longer needs ${o.key ?? "that ticket"}`} title="No longer needs it" onClick={onRemove}>
          <svg width="12" height="12" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** What it points at: its pull requests, sessions and room threads. */
function Links({ links }: { links: TicketLink[] }) {
  if (!links.length) return null;
  return (
    <section className="ticket-links" aria-label="Links">
      <h3 className="ov-label muted">Links</h3>
      {links.map((l) => (
        <LinkRow key={`${l.kind}:${l.kind === "pr" ? l.number : l.kind === "session" ? l.session : l.kind === "room" ? `${l.room}/${l.thread ?? ""}` : l.message}`} link={l} />
      ))}
    </section>
  );
}

function LinkRow({ link: l }: { link: TicketLink }) {
  const sessionName = useSessionName(l.kind === "session" ? l.session : null, "");
  const session = useDesk((s) => (l.kind === "session" ? s.sessions[l.session] : undefined));
  const room = useDesk((s) => (l.kind === "room" ? s.rooms[l.room] : undefined));
  switch (l.kind) {
    case "pr":
      return (
        <div className="ticket-link">
          <span className="chip chip-live">PR #{l.number}</span>
          {/^https:\/\//i.test(l.url) && (
            <button type="button" className="link ticket-link-url" onClick={() => void openUrl(l.url)}>
              {l.url.replace(/^https?:\/\//, "")}
            </button>
          )}
        </div>
      );
    case "session":
      return (
        <div className="ticket-link">
          <span className="chip">session</span>
          <button type="button" className="link mono" disabled={!session} onClick={() => useDesk.getState().open(l.session)}>
            {sessionName || session?.name || "A session since forgotten"}
          </button>
        </div>
      );
    case "room":
      return (
        <div className="ticket-link">
          <span className="chip">room</span>
          <button type="button" className="link" disabled={!room} onClick={() => void useDesk.getState().openRoom(l.room)}>
            {room ? `#${room.slug}` : "A room since deleted"}
            {l.thread ? " ▸ thread" : ""}
          </button>
        </div>
      );
    case "message":
      return null;
  }
}

/** Where a synced ticket's words come from: its Jira or Linear issue, and
 *  whether it still syncs. Its title and description are that issue's,
 *  shown as plain text. */
function IssueLine({ ticket: t }: { ticket: Ticket }) {
  const e = t.external!;
  const url = issueUrl(t);
  const title = SYSTEM_TITLE[e.system];
  return (
    <p className="small muted ticket-issue">
      <span>
        {title} issue <span className="mono">{e.key}</span>
        {!e.synced ? (e.kept ? ", kept here and no longer synced" : ", no longer synced") : ""}
      </span>
      {url && (
        <button type="button" className="link small" onClick={() => openUrl(url)}>
          Open in {title}
        </button>
      )}
    </p>
  );
}
