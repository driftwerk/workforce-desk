import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useChat } from "../chat/store";
import { useSessionName, useSessionNames } from "../groups/names";
import { below } from "../groups/rows";
import { useHubLayout } from "../groups/hubLayout";
import { askMove, ticketSubject } from "../groups/move";
import { sortedSessions, useDesk, localSessions } from "../hub/store";
import type { ActivityParty, Ticket, TicketState } from "../hub/types";
import { PopupPanel, SidePanel } from "../panels/Stage";
import { openUrl } from "../platform";
import { ticketLink } from "../shell/links";
import { tokensText, usdText } from "../spend/spend";
import { Confirm } from "../ui/Confirm";
import { useModal } from "../ui/Dialog";
import { Menu, type MenuEntry } from "../ui/Menu";
import { plainError } from "../ui/plainError";
import { dayClock } from "../floor/time";
import { STATE_TITLE, sessionsOf, spendOf } from "./board";
import { useWaiting } from "./BoardView";
import { CalendarIcon, CycleIcon, ExtIcon, LabelChip, PriorityBars, StateGlyph, TypeGlyph } from "./cardFacts";
import { sprintName } from "./facets";
import { StartSession } from "./StartSession";
import { TicketBody } from "./TicketBody";
import { TicketActivity } from "./TicketComments";
import { TicketFiles, useUploads } from "./TicketFiles";
import { useFileDrop } from "../attachments/Compose";
import { localTicketView } from "./ticketView";
import { TicketOpener, TicketPopupContext, useOpenTicket, useTicketPopup, type TicketPopupFrame } from "./opener";
import { useBoard } from "./store";
import { Assignee, TakeIt, Upstream } from "./TicketCard";
import { issueUrl, SYSTEM_TITLE, takeable } from "../hub/boardSync";
import {
  bylineText,
  dayText,
  factOrder,
  firstParagraph,
  foldSections,
  isEpic,
  layoutOf,
  remoteStateWord,
  spanText,
  type FactId,
  type Layout,
} from "./ticketRich";
import { ActivityFold, Crumbs, Development, Dotted, EpicChildren, EpicProgress, LinkedWork, Person, SectionHead, SubItems } from "./TicketSections";

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

/** The ticket open as a popup over a grid, kept current: the grid dimmed
 *  behind it, modal (Esc or a click outside closes it, focus stays in it
 *  and goes back to its card after). A ticket opened from it opens there
 *  too; its side-panel button moves it to the side panel. */
export function TicketPopup() {
  const id = useBoard((s) => s.popup);
  return id ? <TicketPopupDialog id={id} /> : null;
}

const closePopup = () => useBoard.getState().openPopup(null);
const openInPopup = (id: string) => useBoard.getState().openPopup(id);
const POPUP: TicketPopupFrame = {
  close: closePopup,
  toSidePanel: () => {
    const id = useBoard.getState().popup;
    closePopup();
    if (id) useBoard.getState().openTicket(id);
  },
};

function TicketPopupDialog({ id }: { id: string }) {
  const t = useBoard((s) => s.tickets[id]);
  const supported = useBoard((s) => s.supported);
  const hub = useDesk((s) => s.hub);
  const ref = useRef<HTMLDivElement>(null);
  // The card it was opened from, found again if it was redrawn meanwhile
  // (moved to another column).
  const from = useRef(id);
  const onKeyDown = useModal(ref, closePopup, () => document.querySelector<HTMLElement>(`[data-ticket-card="${CSS.escape(from.current)}"]`));
  // Opened before the board was read: ask for it; gone, or with no hub
  // to ask, it closes.
  useEffect(() => {
    if (t) return;
    if (!hub || supported === false) return closePopup();
    useBoard.getState().fetched(id).catch(closePopup);
  }, [id, t, hub, supported]);
  // Another ticket opened from it: what had focus went with the last one,
  // so focus is on the popup again (Esc and Tab still work).
  const shown = useRef(id);
  useEffect(() => {
    if (shown.current === id) return;
    shown.current = id;
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
  }, [id]);
  return (
    <div className="sheet-backdrop sheet-backdrop-center ticket-popup-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closePopup()} onKeyDown={onKeyDown}>
      <div ref={ref} className="dialog ticket-popup" role="dialog" aria-modal="true" aria-label={t ? `Ticket ${t.key ?? t.title}` : "Ticket"} tabIndex={-1}>
        <TicketPopupContext.Provider value={POPUP}>
          <TicketOpener.Provider value={openInPopup}>
            {t ? (
              <TicketDetail key={t.id} ticket={t} />
            ) : (
              <p className="muted small ticket-popup-note" role="status">
                Reading the ticket…
              </p>
            )}
          </TicketOpener.Provider>
        </TicketPopupContext.Provider>
      </div>
    </div>
  );
}

/** A ticket's frame: the side panel, or the popup it's open in. */
function TicketFrame({ label, chrome, ...props }: ComponentProps<typeof SidePanel>) {
  const popup = useTicketPopup();
  if (!popup) return <SidePanel label={label} chrome={chrome} {...props} />;
  // The popup's dialog is what's labelled.
  return <PopupPanel {...props} onClose={popup.close} onSidePanel={popup.toSidePanel} />;
}

/** How wide the view is, as it resizes: two columns, stacked, or as short
 *  as it goes. Unmeasured (no ResizeObserver, or not laid out), wide. */
const useLayout = (): [(el: HTMLElement | null) => void, Layout] => {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [layout, setLayout] = useState<Layout>("wide");
  // Measured before it paints, so a narrow popup never shows two columns first.
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setLayout(layoutOf(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, layout];
};

/** A ticket beside the board, or over a grid: where it sits, what it says,
 *  its sub-items, development, links, files and one timeline of what
 *  happened to it; beside them (or, narrow, in a band under its title)
 *  what to do with it, what it needs, and its facts. */
export function TicketDetail({ ticket: t }: { ticket: Ticket }) {
  const all = useBoard((s) => s.tickets);
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
  const [whole, setWhole] = useState(false);
  const [measured, layout] = useLayout();
  const handEntries = useHandEntries(t);
  const movable = useHubLayout((s) => s.layout !== null);
  const store = useBoard.getState;

  const act = (p: Promise<void>) => {
    setProblem(null);
    p.catch((e) => setProblem(plainError(e)));
  };
  const board = useBoard((s) => s.boards[t.board]);
  const sync = board?.sync ?? null;
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
  const local = !t.external && !sync;
  const synced = !!t.external?.synced;
  const uploads = useUploads(t, setProblem);
  // Files dropped on a ticket of your own: the system's drag and drop in
  // the app, the page's in the browser preview (drop/route.ts).
  const drop = useFileDrop((files) => void uploads.add(files), setProblem);
  const issue = t.external ? issueUrl(t) : null;
  // A synced ticket's issue is read whole when it opens, now and then:
  // what the pull doesn't bring (a file attached since, its development).
  useEffect(() => {
    if (!t.external?.synced) return;
    localTicketView()
      ?.readIssue(t.id)
      .then((v) => useBoard.getState().heard(v))
      .catch(() => {});
  }, [t.id, t.external?.synced]);
  const popup = useTicketPopup();
  const wide = layout === "wide";
  const compact = layout === "compact";
  const byline = bylineText(t, layout);
  const working = t.assignee?.kind === "session" ? t.assignee.id : null;
  // An epic reads as its progress and children; its comments and history
  // fold in its details column.
  const epic = isEpic(t);
  const openHand = (e: React.MouseEvent<HTMLElement>) => setMenu({ kind: "hand", at: below(e.currentTarget), from: e.currentTarget });

  const description = () => {
    if (editing === "body")
      return (
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
      );
    if (!t.body)
      return (
        <button type="button" className="ticket-edit ticket-text" title="Change what it's about" onClick={() => startEditing("body")}>
          <span className="faint">Add what it's about, and what done looks like</span>
        </button>
      );
    // A long description shows its first sections (the shortest view, its
    // first paragraph) until asked for all of it.
    const first = compact ? firstParagraph(t.body) : null;
    const fold = foldSections(t.body);
    const cut = !whole && (compact ? first !== null && first !== t.body.trim() : fold.more > 0);
    return (
      <>
        <div className={cut && compact ? "ticket-clamp" : undefined}>
          <TicketBody text={cut ? (compact ? first! : fold.shown) : t.body} onEdit={() => startEditing("body")} />
        </div>
        {cut && (
          <button type="button" className="link ticket-whole" onClick={() => setWhole(true)}>
            Show all of it{!compact && fold.more ? ` · ${fold.more} more section${fold.more === 1 ? "" : "s"}` : ""}
          </button>
        )}
      </>
    );
  };

  const actions = (
    <Actions
      ticket={t}
      band={!wide}
      onStart={() => setStarting(true)}
      onHand={openHand}
      onDrop={() => act(store().move(t.id, { state: t.state === "dropped" ? "backlog" : "dropped" }))}
    />
  );
  const needs = <Needs ticket={t} neededBy={neededBy} onProblem={setProblem} band={!wide} />;
  const facts = <Facts ticket={t} layout={layout} onState={(state) => act(store().move(t.id, { state }))} />;
  const foot = (
    <div className="ticket-foot">
      <button
        type="button"
        className="link"
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
        <button type="button" className="link" onClick={() => askMove(ticketSubject(t))}>
          Move to group…
        </button>
      )}
      <button type="button" className="link" onClick={() => setDeleting(true)}>
        Delete…
      </button>
    </div>
  );

  return (
    <TicketFrame
      className="ticket-panel"
      label={`Ticket ${t.key ?? t.title}`}
      noun="this ticket"
      onClose={() => store().openTicket(null)}
      title={
        <>
          {t.key && <span className="chip ticket-key">{t.key}</span>}
          {issue && t.external && (
            <button type="button" className="link ticket-open-issue" aria-label={`Open in ${SYSTEM_TITLE[t.external.system]}`} onClick={() => openUrl(issue)}>
              Open in {SYSTEM_TITLE[t.external.system]} <ExtIcon />
            </button>
          )}
          <span className="rpanel-name" />
        </>
      }
      actions={
        // Over a grid, it's a quick look: pinning and snoozing are on the
        // board.
        !popup && (
          <>
            <button type="button" className="btn btn-sm ticket-head-btn" aria-pressed={t.pinned} onClick={() => act(store().edit(t.id, { pinned: !t.pinned }))}>
              {t.pinned ? "Pinned" : "Pin"}
            </button>
            <button
              type="button"
              className="btn btn-sm ticket-head-btn"
              aria-pressed={t.snoozed}
              aria-haspopup="menu"
              title={t.snoozedUntil ? `Snoozed until ${dayClock(t.snoozedUntil)}` : "Hide it from the board for a while"}
              onClick={(e) => setMenu({ kind: "snooze", at: below(e.currentTarget), from: e.currentTarget })}
            >
              {t.snoozed && t.snoozedUntil ? `Snoozed till ${dayClock(t.snoozedUntil)}` : "Snooze"}
            </button>
          </>
        )
      }
    >
      <div ref={measured} className={`ticket-body ticket-view ticket-${layout}`}>
        <div className={`ticket-read${local && drop.dragging ? " is-dropping" : ""}`} {...(local ? drop.handlers : {})}>
          <div className="ticket-top">
            <Crumbs ticket={t} board={board} layout={layout} />
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
            {byline ? <p className="ticket-byline">{byline}</p> : t.createdBy.kind !== "you" && <WrittenBy who={t.createdBy} />}
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
          </div>
          {!wide && (
            <aside className={`ticket-band${epic ? " ticket-band-epic" : ""}`} aria-label="Details">
              {actions}
              {t.needs.length > 0 && needs}
              {facts}
              {t.needs.length === 0 && needs}
            </aside>
          )}
          <div className="ticket-reading">
            {epic && <EpicProgress ticket={t} />}
            <article className="ticket-description" aria-label="Description">
              {description()}
            </article>
            {epic ? (
              <EpicChildren ticket={t} />
            ) : t.external?.system === "linear" ? (
              <>
                <Development ticket={t} layout={layout} />
                <SubItems ticket={t} layout={layout} />
              </>
            ) : (
              <>
                <SubItems ticket={t} layout={layout} />
                <Development ticket={t} layout={layout} />
              </>
            )}
            {/* The shortest view of a synced ticket leaves its links and
                files to the side panel (↗); your own keeps its files, where
                you drop them. */}
            {!(compact && synced) && <LinkedWork ticket={t} working={working} />}
            {!(compact && synced) && <TicketFiles ticket={t} local={local} uploads={uploads} />}
            {!epic ? <TicketActivity ticket={t} layout={layout} /> : !wide && <ActivityFold ticket={t} layout={layout} />}
            {!wide && foot}
          </div>
        </div>
        {wide && (
          <aside className="ticket-side" aria-label="Details">
            {actions}
            {needs}
            {facts}
            {epic && <ActivityFold ticket={t} layout="compact" />}
            {foot}
          </aside>
        )}
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
    </TicketFrame>
  );
}

/** What to do with it: start a session on it, hand it to one, take it on
 *  its issue (or that it's yours there already), drop it. */
function Actions({
  ticket: t,
  band,
  onStart,
  onHand,
  onDrop,
}: {
  ticket: Ticket;
  band: boolean;
  onStart: () => void;
  onHand: (e: React.MouseEvent<HTMLElement>) => void;
  onDrop: () => void;
}) {
  const board = useBoard((s) => s.boards[t.board]);
  const sync = board?.sync;
  const canTake = takeable(board, t);
  const yours = !!sync?.me && !!t.external?.assignee && t.external.assignee.id === sync.me;
  const take = canTake ? (
    <TakeIt ticket={t} className={`btn ${band ? "btn-sm " : ""}ticket-act ticket-take-it`} />
  ) : yours && sync ? (
    <span className={`btn ${band ? "btn-sm " : ""}ticket-act ticket-yours`}>Yours on {SYSTEM_TITLE[sync.system]}</span>
  ) : null;
  const drop = (
    <button type="button" className="link ticket-drop" onClick={onDrop}>
      {t.state === "dropped" ? "Bring it back" : "Drop"}
    </button>
  );
  const start = (
    <button type="button" className={`btn btn-signal ${band ? "btn-sm " : ""}ticket-act ticket-start`} onClick={onStart}>
      Start a session on it
    </button>
  );
  const hand = (
    <button type="button" className={`btn ${band ? "btn-sm " : ""}ticket-act ticket-hand`} aria-haspopup="menu" onClick={onHand}>
      Hand to…
    </button>
  );
  if (band)
    return (
      <div className="ticket-acts ticket-acts-band">
        {start}
        {hand}
        {take}
        {drop}
      </div>
    );
  return (
    <div className="ticket-acts">
      {start}
      <div className={`ticket-acts-row${take ? "" : " ticket-acts-row-two"}`}>
        {hand}
        {take}
        {drop}
      </div>
    </div>
  );
}

/** Its facts: Desk's own (its state, who works on it, what it cost), and
 *  what its issue says, each with what the issue calls it, faint, where
 *  Desk's word differs. Narrow, the first eight in two columns, the rest
 *  a click away. */
function Facts({ ticket: t, layout, onState }: { ticket: Ticket; layout: Layout; onState: (s: TicketState) => void }) {
  const [all, setAll] = useState(false);
  const waiting = useWaiting()(t);
  const spend = useTicketSpend(t);
  const sync = useBoard((s) => s.boards[t.board]?.sync ?? null);
  const session = useDesk((s) => (t.assignee?.kind === "session" ? s.sessions[t.assignee.id] : undefined));
  const popup = useTicketPopup();
  const e = t.external;
  const d = e?.details;
  const system = sync && e ? e.system : null;
  const wide = layout === "wide";
  const compact = layout === "compact";
  const on = (words: string) => (wide && system ? <span className="ticket-there">{words}</span> : null);
  const remote = remoteStateWord(t.state, d?.remoteState);
  const goToSession = session
    ? () => {
        popup?.close();
        useDesk.getState().open(session.id);
      }
    : undefined;
  const mine = (who: ActivityParty) => (
    <button type="button" className="ticket-fact-who" disabled={!goToSession} title={goToSession ? "Go to the session" : undefined} onClick={goToSession}>
      <Assignee who={who} waiting={waiting} />
    </button>
  );
  const facts: Partial<Record<FactId, { label: string; value: ReactNode }>> = {};
  if (d?.kind) facts.type = { label: "Type", value: <><TypeGlyph kind={d.kind} level={d.kindLevel} />{d.kind}</> };
  facts.state = {
    label: "State",
    value: (
      <>
        {/* The state's word, as wide as it is, with the select over it. */}
        <span className="ticket-select">
          <span aria-hidden="true">{STATE_TITLE[t.state]}</span>
          <select id={`ticket-state-${t.id}`} aria-label="State" value={t.state} onChange={(ev) => onState(ev.target.value as TicketState)}>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_TITLE[s]}
              </option>
            ))}
          </select>
        </span>
        {remote && !compact && (
          <span className="ticket-there" title={`What ${system ? SYSTEM_TITLE[system] : "its issue"} calls it`}>
            {d?.stateKind && <StateGlyph kind={d.stateKind} name={remote} size={12} />}
            {remote}
            {!d?.stateKind && wide && system ? ` on ${SYSTEM_TITLE[system]}` : ""}
          </span>
        )}
      </>
    ),
  };
  if (system && t.assignee)
    facts.working = {
      label: "Working",
      value: (
        <>
          {mine(t.assignee)}
          {!compact && session?.state === "working" && <span className="ticket-there">working</span>}
        </>
      ),
    };
  if (spend && spend.calls > 0)
    facts.spent = {
      label: "Spent",
      value: (
        <span title="What its sessions spent on it this month, at API prices">
          {spend.capped ? "at least " : ""}
          {tokensText(spend.tokens)} tokens · {usdText(spend.usd)}
        </span>
      ),
    };
  if (system && e && e.assignee !== undefined)
    facts.assignee = {
      label: "Assignee",
      value: (
        <>
          <Upstream who={e.assignee} me={sync?.me} system={system} />
          {e.assignee && on(` on ${SYSTEM_TITLE[system]}`)}
        </>
      ),
    };
  else if (!system) facts.assignee = { label: "Assignee", value: t.assignee ? mine(t.assignee) : <span className="muted">Unassigned</span> };
  const epic = isEpic(t);
  // An epic's byline says who wrote it.
  if (d?.reporter && system === "jira" && !epic) facts.reporter = { label: "Reporter", value: <Person name={d.reporter} me={sync?.meName} /> };
  if (d?.priority || d?.priorityRank)
    facts.priority = { label: "Priority", value: <>{d.priorityRank !== undefined && <PriorityBars rank={d.priorityRank} name={d.priority} />}{d.priority}</> };
  if (epic && (d?.subItems?.total ?? d?.children?.length))
    facts.children = {
      label: "Children",
      value: (
        <>
          {d!.subItems?.total ?? d!.children!.length}
          {d!.subItems && <span className="ticket-there">{d!.subItems.done} done</span>}
        </>
      ),
    };
  if (epic && d?.childPoints)
    facts.points = {
      label: "Points",
      value: (
        <span className="mono ticket-points-of">
          {d.childPoints.done} / {d.childPoints.total}
        </span>
      ),
    };
  else if (d?.points !== undefined)
    facts.points = system === "linear" ? { label: "Estimate", value: <><span className="mono">{d.points}</span> pts</> } : { label: "Points", value: <span className="mono">{d.points}</span> };
  if (d?.sprint) {
    const name = sprintName(d.sprint);
    const when = d.sprint.starts && d.sprint.ends && system === "linear" ? spanText(d.sprint.starts, d.sprint.ends) : d.sprint.ends ? `ends ${dayText(d.sprint.ends)}` : null;
    facts.sprint = { label: system === "linear" ? "Cycle" : "Sprint", value: <><CycleIcon size={12} />{name}{when && !compact && <span className="ticket-there">{when}</span>}</> };
  }
  if (d?.labels?.length) facts.labels = { label: "Labels", value: <>{d.labels.map((l) => <LabelChip key={l} name={l} />)}</> };
  if (d?.project) facts.project = { label: "Project", value: system === "linear" ? <Dotted name={d.project} /> : d.project };
  if (d?.components?.length) facts.components = { label: "Components", value: d.components.join(", ") };
  if (d?.fixVersions?.length) facts.fixVersion = { label: "Fix version", value: <span className="mono ticket-version">{d.fixVersions.join(", ")}</span> };
  if (d?.start) facts.start = { label: "Start", value: <><CalendarIcon />{dayText(d.start)}</> };
  if (d?.due) facts.due = { label: "Due", value: <><CalendarIcon />{dayText(d.due)}</> };
  if (d?.created && system === "linear") facts.created = { label: "Created", value: dayText(d.created) };
  const has = (f: FactId) => !!facts[f];
  const every = factOrder(system, has);
  const shown = wide || all ? every : factOrder(system, has, true);
  const list = (ids: FactId[]) => (
    <dl className="ticket-facts">
      {ids.map((f) => (
        <Fragment key={f}>
          <dt>{f === "state" ? <label htmlFor={`ticket-state-${t.id}`}>State</label> : facts[f]!.label}</dt>
          <dd className={`ticket-fact-${f}`}>{facts[f]!.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
  if (wide) return list(shown);
  const half = Math.ceil(shown.length / 2);
  return (
    <>
      <div className="ticket-facts-cols">
        {list(shown.slice(0, half))}
        {list(shown.slice(half))}
      </div>
      {every.length > shown.length && (
        <button type="button" className="link small ticket-all-facts" onClick={() => setAll(true)}>
          All {every.length} details
        </button>
      )}
    </>
  );
}

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

/** What it needs done first (a need from its issue's "is blocked by" says
 *  so), and what needs it; a need added by its key or words, or taken off.
 *  In the band, one line each, or that it needs nothing yet. */
function Needs({ ticket: t, neededBy, onProblem, band }: { ticket: Ticket; neededBy: Ticket[]; onProblem: (p: string | null) => void; band: boolean }) {
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
  // The needs its issue says it's blocked by there.
  const system = t.external ? SYSTEM_TITLE[t.external.system] : null;
  const fromThere = new Set((t.external?.details?.links ?? []).filter((l) => l.rel === "blockedBy").map((l) => l.issue.key));
  const adder = adding ? (
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
  ) : null;
  const rows = (
    <>
      {needs.map((o) => (
        <NeedRow key={o.id} ticket={o} there={o.external && fromThere.has(o.external.key) ? `${system} link` : null} onRemove={() => need(o.id, false)} />
      ))}
    </>
  );
  if (band)
    return (
      <section className="ticket-needs ticket-needs-band" aria-label="Needs">
        <div className="ticket-needs-line">
          <h3 className="ticket-band-label">Needs</h3>
          {needs.length ? <div className="ticket-needs-rows">{rows}</div> : <span className="faint">nothing yet</span>}
          {!needs.length && !adding && (
            <button type="button" className="link ticket-need-more" onClick={() => setAdding(true)}>
              Add…
            </button>
          )}
        </div>
        {adder}
      </section>
    );
  return (
    <section className="ticket-needs" aria-label="Needs">
      <SectionHead title="Needs" note="done first" />
      {rows}
      {adder ?? (
        <button type="button" className="link ticket-need-more" onClick={() => setAdding(true)}>
          Add a ticket it needs first…
        </button>
      )}
      {neededBy.length > 0 && (
        <>
          <SectionHead title="Needed by" />
          {neededBy.map((o) => (
            <NeedRow key={o.id} ticket={o} />
          ))}
        </>
      )}
    </section>
  );
}

function NeedRow({ ticket: o, there, onRemove }: { ticket: Ticket; there?: string | null; onRemove?: () => void }) {
  const openTicket = useOpenTicket();
  const d = o.external?.details;
  return (
    <div className="ticket-need">
      <button type="button" className="ticket-need-open" onClick={() => openTicket(o.id)}>
        {d?.kind ? <TypeGlyph kind={d.kind} level={d.kindLevel} size={12} /> : d?.stateKind ? <StateGlyph kind={d.stateKind} name={d.remoteState} size={12} /> : null}
        <span className="mono board-key">{o.key}</span>
        <span className="ticket-need-title">{o.title}</span>
        {there && <span className="ticket-there">{there}</span>}
        <span className={`small ${o.state === "done" ? "state-done" : "faint"}`}>{STATE_TITLE[o.state]}</span>
      </button>
      {onRemove && (
        <button type="button" className="icon-btn-sm ticket-need-off" aria-label={`It no longer needs ${o.key ?? "that ticket"}`} title="No longer needs it" onClick={onRemove}>
          <svg width="12" height="12" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      )}
    </div>
  );
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
