import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/react";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useChat } from "../chat/store";
import { useBoss } from "../crew/chargeStore";
import { plansOn, usePlans } from "../crew/planStore";
import { waitsOnYou } from "../floor/background";
import { useNeedCounts } from "../floor/store";
import { agentItem, sessionItem } from "../groups/model";
import { PLUGINS, SENSORS, DragChip, MoreIcon, below, type Operation } from "../groups/rows";
import { useDesk, localSessions } from "../hub/store";
import type { Ticket, TicketState } from "../hub/types";
import { useMinute } from "../floor/RightNow";
import { Menu, type MenuEntry } from "../ui/Menu";
import { leftFilterOf, syncStatus } from "../hub/boardSync";
import { BoardDialog } from "./BoardDialogs";
import { BoardActionDialog, boardEntries, type BoardAction } from "./boardActions";
import { NewTokenDialog } from "./LinkBoard";
import { LeftFilterShelf, SyncBar } from "./SyncBar";
import { hubNameOf, localSync, syncChoices, useSyncHubs } from "./syncStore";
import { FILTERS, STATE_TITLE, anchored, planOfTickets, statesOf, columns, keyOf, landing, lineAt, nudge, shelfLabel, snoozed, waitingOnYou, type BoardFilter, type Column, type Over } from "./board";
import { NewTicket } from "./NewTicket";
import { shownBoard, useBoard } from "./store";
import { TicketCard } from "./TicketCard";

/** Whether a ticket's session or agent waits on the person, by the Floor's
 *  own rule (its needs, else the session's state). */
export const useWaiting = (): ((t: Ticket) => boolean) => {
  const sessions = useDesk((s) => localSessions(s.sessions));
  const needs = useNeedCounts();
  const localHub = useChat((s) => s.hubs.find((h) => h.local)?.id ?? null);
  return useCallback(
    (t: Ticket) => {
      const a = t.assignee;
      if (!a || t.state === "done" || t.state === "dropped") return false;
      if (a.kind === "session") {
        const s = sessions[a.id];
        return needs.has(sessionItem(a.id)) || (!!s && waitsOnYou(s));
      }
      return a.kind === "agent" && !!localHub && needs.has(agentItem({ hubId: localHub, id: a.id }));
    },
    [sessions, needs, localHub],
  );
};

/** The column a card dropped on `id` goes to the end of: a column's own
 *  area (`col:<state>`), or its tab in a narrow pane (`tab:<state>`); null
 *  for a card (it goes beside that card). */
export const columnDroppedOn = (id: string): TicketState | null => (id.startsWith("col:") || id.startsWith("tab:") ? (id.slice(4) as TicketState) : null);

/** Every ticket's state, worked out once for the board's cards. */
const States = createContext<ReadonlyMap<string, TicketState>>(new Map());
/** The plan each ticket is in, by its goal, for the board's cards. */
const Plans = createContext<ReadonlyMap<string, string>>(new Map());
/** Where a card opens its ticket: the panel beside the main window's view,
 *  unless the board is somewhere that has none (a grid's own window). */
const TicketOpener = createContext<(id: string) => void>((id) => useBoard.getState().openTicket(id));

const KEYS: Record<string, "up" | "down" | "left" | "right"> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

/** A board shown in a grid's pane: which one, and its filter, which the
 *  pane's header shows. */
export interface BoardInPane {
  board: string;
  filter: BoardFilter;
  onFilter: (f: BoardFilter) => void;
  /** Opens a ticket, where this pane's window can show it. */
  openTicket: (id: string) => void;
}

/** The board: its five columns of tickets, filtered and searched; cards
 *  dragged (or moved with Alt+arrows) between and within columns. With
 *  `pane`, that board in a grid's pane: under the pane's header, which has
 *  its name and filter, its columns alone (and its sync while that has a
 *  problem); a narrow pane shows a column at a time, a short one counts. */
export function Board({ pane }: { pane?: BoardInPane } = {}) {
  const supported = useBoard((s) => s.supported);
  const board = useBoard((s) => (pane ? (s.boards[pane.board] ?? null) : shownBoard(s)));
  const boards = useBoard((s) => s.boards);
  const all = useBoard((s) => s.tickets);
  const fail = useDesk((s) => s.fail);
  const boss = useBoss();
  const waiting = useWaiting();
  const now = useMinute();
  const [ownFilter, setOwnFilter] = useState<BoardFilter>("all");
  const filter = pane?.filter ?? ownFilter;
  const setFilter = pane?.onFilter ?? setOwnFilter;
  // Ids of its own: a grid can show more than one board.
  const uid = useId();
  const searchId = `${uid}-search`;
  const [q, setQ] = useState("");
  const [shelfOpen, setShelfOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [naming, setNaming] = useState(false);
  const [acting, setActing] = useState<BoardAction | null>(null);
  const [newToken, setNewToken] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [said, setSaid] = useState("");
  const menuButton = useRef<HTMLButtonElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());

  const mine = useMemo(() => (board ? Object.values(all).filter((t) => t.board === board.id) : []), [all, board]);
  // Issues that left the import filter wait on their own shelf, not in a
  // column, until the person keeps or drops them.
  const left = useMemo(() => leftFilterOf(mine), [mine]);
  const onBoard = useMemo(() => (left.length ? mine.filter((t) => !left.includes(t)) : mine), [mine, left]);
  // A synced board is synced at once when it's shown, and its hub's name
  // read for what its sync bar says.
  const synced = !!board?.sync;
  useEffect(() => {
    if (!board || !synced) return;
    void useSyncHubs.getState().load();
    void localSync()?.syncNow(board.id).catch(() => {});
  }, [board?.id, synced]);
  const pairedHubs = useChat((s) => s.hubs);
  const keptHubs = useSyncHubs((s) => s.hubs);
  const tokenFor = board?.sync?.via.kind === "hub" ? syncChoices(pairedHubs, keptHubs).find((c) => board.sync?.via.kind === "hub" && c.id === board.sync.via.hub) : undefined;
  // The boss's plans on this board, each read in full for its tickets.
  const plansAll = usePlans((s) => s.plans);
  const details = usePlans((s) => s.details);
  const plans = useMemo(() => (board ? plansOn(plansAll, board.id) : []), [plansAll, board]);
  useEffect(() => {
    for (const p of plans) if (!usePlans.getState().details[p.id]) void usePlans.getState().fetch(p.id);
  }, [plans]);
  const [planShown, setPlan] = useState<string | null>(null);
  const plan = planShown && plans.some((p) => p.id === planShown) ? planShown : null;
  const ticketPlans = useMemo(() => planOfTickets(plans.map((p) => details[p.id]).filter((d) => !!d)), [plans, details]);
  const planTickets = useMemo(() => (plan ? new Set([...ticketPlans].filter(([, p]) => p === plan).map(([t]) => t)) : null), [plan, ticketPlans]);
  const planNames = useMemo(() => new Map(plans.map((p) => [p.id, p.goal])), [plans]);
  const planChips = useMemo(() => new Map([...ticketPlans].map(([t, p]) => [t, planNames.get(p) ?? ""])), [ticketPlans, planNames]);
  const cols = useMemo(() => columns(onBoard, { filter, q, now, waiting, plan: planTickets }), [onBoard, filter, q, now, waiting, planTickets]);
  const counts = useMemo(() => columns(onBoard, { filter: "all", q: "", now, waiting }), [onBoard, now, waiting]);
  const waitingCount = mine.filter((t) => !snoozed(t, now) && waitingOnYou(t, waiting)).length;

  const states = useMemo(() => statesOf(all), [all]);
  const move = (id: string, shown: Parameters<ReturnType<typeof useBoard.getState>["move"]>[1]) => {
    const t = all[id];
    // Placed in the whole column, whatever the filter hides.
    const mv = anchored(shown, mine, id);
    useBoard
      .getState()
      .move(id, mv)
      .then(() => {
        const after = useBoard.getState().tickets[id];
        if (t && after) setSaid(`${t.key ?? "The ticket"} is in ${STATE_TITLE[after.state]}`);
        requestAnimationFrame(() => cards.current.get(id)?.focus());
      })
      .catch(fail);
  };

  const onCardKey = (t: Ticket, e: KeyboardEvent<HTMLElement>) => {
    const dir = e.altKey && !e.metaKey && !e.ctrlKey ? KEYS[e.key] : undefined;
    if (!dir) return;
    e.preventDefault();
    if (t.state === "dropped") return setSaid(`${t.key ?? "It"} is dropped: Bring it back from its panel first`);
    const mv = nudge(cols, t.id, dir);
    if (!mv) return setSaid(dir === "up" ? "Already at the top" : dir === "down" ? "Already at the bottom" : dir === "left" ? "Already in the first column" : "Already in the last column");
    move(t.id, mv);
  };

  // Enter on a typed key opens that ticket, whichever board it is on.
  const openTyped = () => {
    const key = keyOf(q);
    if (!key) return;
    const found = Object.values(all).find((t) => t.key?.toUpperCase() === key);
    if (found) {
      useBoard.getState().show(found.board);
      useBoard.getState().openTicket(found.id);
    } else setSaid(`There's no ${key}`);
  };

  if (pane && !board) return <BoardPaneNote supported={supported} />;

  if (supported === false)
    return (
      <main className="board" aria-label="Board">
        <header className="board-head">
          <h1 className="display">Board</h1>
        </header>
        <p className="empty muted">This computer's hub has no board yet. Update Desk to keep tickets here.</p>
      </main>
    );

  // Still reading: never "make one" over boards that are there.
  if (!board && supported === null)
    return (
      <main className="board" aria-label="Board">
        <header className="board-head">
          <h1 className="display">Board</h1>
        </header>
        <p className="empty faint">Reading the board…</p>
      </main>
    );

  if (!board)
    return (
      <main className="board" aria-label="Board">
        <header className="board-head">
          <h1 className="display">Board</h1>
        </header>
        <section className="floor-card board-empty">
          <h2 className="floor-card-title">Keep a board of tickets</h2>
          <p className="muted small">
            Tickets are work you hand to sessions and agents: each has a key like ACM-12, what it needs first, and its history. Sessions can move their own tickets as they go.
          </p>
          <div>
            <button type="button" className="btn btn-signal" onClick={() => setNaming(true)}>
              Make a board
            </button>
          </div>
        </section>
        {naming && <BoardDialog onClose={() => setNaming(false)} />}
      </main>
    );

  const menuEntries: MenuEntry[] = [
    ...Object.values(boards)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((b) => ({ kind: "item" as const, label: b.name, checked: b.id === board.id, onSelect: () => useBoard.getState().show(b.id) })),
    { kind: "separator" },
    { kind: "item", label: "New board…", onSelect: () => setNaming(true) },
    ...boardEntries(board, setActing),
  ];

  const columnsShown = (
    <States.Provider value={states}>
      <Plans.Provider value={planChips}>
        <TicketOpener.Provider value={pane?.openTicket ?? ((id) => useBoard.getState().openTicket(id))}>
          <Columns
            cols={cols}
            counts={counts}
            all={all}
            waiting={waiting}
            shelfOpen={shelfOpen}
            onShelf={() => setShelfOpen((o) => !o)}
            onMove={move}
            onCardKey={onCardKey}
            register={(id, el) => (el ? cards.current.set(id, el) : cards.current.delete(id))}
            ids={uid}
            tabs={!!pane}
          />
        </TicketOpener.Provider>
      </Plans.Provider>
    </States.Provider>
  );
  const live = (
    <p className="sr-only" aria-live="polite">
      {said}
    </p>
  );

  if (pane)
    return (
      <div className="board board-in-pane" aria-label={`Board ${board.name}`}>
        {board.sync && <PaneSync board={board} now={now} />}
        <LeftFilterShelf board={board} tickets={left} />
        {columnsShown}
        <BoardShort counts={counts} waiting={waitingCount} />
        {live}
      </div>
    );

  return (
    <main className="board" aria-label="Board">
      <header className="board-head">
        <h1 className="display">{/board$/i.test(board.name) ? board.name : `${board.name} board`}</h1>
        <span className="floor-time">{[board.prefix ?? board.sync?.target, boss?.name ? `run by ${boss.name}` : null].filter(Boolean).join(" · ")}</span>
        <button
          ref={menuButton}
          type="button"
          className="icon-btn-sm"
          aria-label="Boards"
          aria-haspopup="menu"
          title="Other boards, rename, delete, link to Jira or Linear"
          onClick={(e) => setMenu(below(e.currentTarget))}
        >
          <MoreIcon />
        </button>
        <span className="board-head-gap" />
        <div className="search-filters" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className="chip-btn" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
              {f.id === "waiting" && waitingCount > 0 ? ` · ${waitingCount}` : ""}
            </button>
          ))}
        </div>
        {plans.length > 0 && (
          <select className="pc-engine board-plan" aria-label="Plan" value={plan ?? ""} onChange={(e) => setPlan(e.target.value || null)}>
            <option value="">Every plan</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                Plan: {p.goal}
              </option>
            ))}
          </select>
        )}
        <label className="sr-only" htmlFor={searchId}>
          Search tickets
        </label>
        <input
          id={searchId}
          className="board-search"
          value={q}
          placeholder={`Search or ${board.prefix ?? board.sync?.target ?? "ACM"}-12`}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") openTyped();
            else if (e.key === "Escape" && q) {
              e.preventDefault();
              setQ("");
            }
          }}
        />
        <button type="button" className="btn btn-signal" onClick={() => setAdding(true)}>
          New ticket
        </button>
      </header>
      {board.sync && <SyncBar board={board} now={now} onToken={tokenFor ? () => setNewToken(true) : undefined} />}
      <LeftFilterShelf board={board} tickets={left} />
      {columnsShown}
      {live}
      {menu && (
        <Menu
          label="Boards"
          at={menu}
          entries={menuEntries}
          onClose={(refocus) => {
            if (refocus) menuButton.current?.focus();
            setMenu(null);
          }}
        />
      )}
      {adding && <NewTicket board={board} onClose={() => setAdding(false)} />}
      {naming && <BoardDialog onClose={() => setNaming(false)} />}
      {acting && <BoardActionDialog board={board} action={acting} onClose={() => setActing(null)} />}
      {newToken && tokenFor && <NewTokenDialog choice={tokenFor} onClose={() => setNewToken(false)} />}
    </main>
  );
}

/** The five columns, as one drag-and-drop area. */
function Columns({
  cols,
  counts,
  all,
  waiting,
  shelfOpen,
  onShelf,
  onMove,
  onCardKey,
  register,
  ids,
  tabs = false,
}: {
  /** What its element ids start with. */
  ids: string;
  /** Column tabs, for a pane too narrow for every column (which then
   *  shows the one picked): each takes a card dropped on it. */
  tabs?: boolean;
  cols: Column[];
  /** The columns unfiltered, for their counts. */
  counts: Column[];
  all: Readonly<Record<string, Ticket>>;
  waiting: (t: Ticket) => boolean;
  shelfOpen: boolean;
  onShelf: () => void;
  onMove: (id: string, mv: { state: TicketState; before?: string; after?: string }) => void;
  onCardKey: (t: Ticket, e: KeyboardEvent<HTMLElement>) => void;
  register: (id: string, el: HTMLElement | null) => void;
}) {
  const [line, setLine] = useState<{ state: TicketState; before: string | null } | null>(null);
  // The column a narrow pane shows, until one is picked: what's being done,
  // else what's next, else the first with cards.
  const [picked, setPicked] = useState<TicketState | null>(null);
  const has = (state: TicketState) => cols.some((c) => c.state === state && c.cards.length > 0);
  const on = picked ?? (has("doing") ? "doing" : has("todo") ? "todo" : (cols.find((c) => c.cards.length)?.state ?? cols[0]?.state ?? null));
  const dragged = useRef(false);
  const overOf = (op: Operation): Over | null => {
    const { source, target } = op;
    if (!source || !target || source.type !== "ticket") return null;
    const id = String(target.id);
    const column = columnDroppedOn(id);
    if (column) return { column };
    const rect = target.element?.getBoundingClientRect();
    return { card: id, upper: rect ? op.position.current.y < rect.top + rect.height / 2 : true };
  };
  const show = (op: Operation) => {
    const over = overOf(op);
    const next = over ? lineAt(cols, over) : null;
    setLine((was) => (was?.state === next?.state && was?.before === next?.before ? was : next));
  };
  return (
    <DragDropProvider
      sensors={SENSORS}
      plugins={PLUGINS}
      onDragMove={(e) => show(e.operation)}
      onDragOver={(e) => show(e.operation)}
      onDragEnd={(e) => {
        const source = e.operation.source;
        const over = e.canceled ? null : overOf(e.operation);
        setLine(null);
        dragged.current = true;
        setTimeout(() => (dragged.current = false), 0);
        if (!source || !over) return;
        const mv = landing(cols, String(source.id), over);
        if (mv) onMove(String(source.id), mv);
      }}
    >
      {tabs && (
        <div className="board-tabs" role="tablist" aria-label="Column">
          {cols.map((c, i) => (
            <ColumnTab
              key={c.state}
              col={c}
              count={counts[i]!.cards.length + counts[i]!.shelf.length}
              on={on === c.state}
              over={line?.state === c.state}
              panel={`${ids}-col-${c.state}`}
              onPick={() => setPicked(c.state)}
            />
          ))}
        </div>
      )}
      <div className="board-cols">
        {cols.map((c, i) => (
          <ColumnView
            key={c.state}
            ids={ids}
            on={on === c.state}
            col={c}
            count={counts[i]!.cards.length + counts[i]!.shelf.length}
            all={all}
            waiting={waiting}
            line={line?.state === c.state ? line.before : undefined}
            shelfOpen={shelfOpen}
            onShelf={onShelf}
            dragged={dragged}
            onCardKey={onCardKey}
            register={register}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>{(source) => <DragChip mono>{all[String(source.id)]?.key ?? "Ticket"}</DragChip>}</DragOverlay>
    </DragDropProvider>
  );
}

/** A column's tab, in a narrow pane: picks the column shown, and takes a
 *  card dropped on it to the end of that column. */
function ColumnTab({ col, count, on, over, panel, onPick }: { col: Column; count: number; on: boolean; over: boolean; panel: string; onPick: () => void }) {
  const el = useRef<HTMLButtonElement | null>(null);
  useDroppable({ id: `tab:${col.state}`, type: "column", accept: "ticket", element: el, collisionPriority: 2 });
  return (
    <button
      ref={el}
      type="button"
      role="tab"
      aria-selected={on}
      aria-controls={panel}
      className={`board-tab ${over ? "board-tab-over" : ""}`}
      onClick={onPick}
    >
      {count > 0 ? `${col.title} ${count}` : col.title}
    </button>
  );
}

/** A board in a short pane: how many tickets each column has, and how
 *  many wait on you. */
function BoardShort({ counts, waiting }: { counts: Column[]; waiting: number }) {
  const shown = counts.filter((c) => c.state === "todo" || c.state === "doing" || c.state === "review");
  return (
    <ul className="board-short" aria-label="Counts">
      {shown.map((c) => (
        <li key={c.state} className="board-short-tile">
          <span className="board-short-label">{c.title}</span>
          <span className="board-short-n display">{c.cards.length + c.shelf.length}</span>
        </li>
      ))}
      <li className={`board-short-tile ${waiting ? "board-short-waiting" : ""}`}>
        <span className="board-short-label">Waiting on me</span>
        <span className="board-short-n display">{waiting}</span>
      </li>
    </ul>
  );
}

/** A board in a pane says its sync in the pane's header while it's well;
 *  here, only once it isn't (paused, or a problem), with what to do. */
function PaneSync({ board, now }: { board: NonNullable<ReturnType<typeof shownBoard>>; now: number }) {
  const kept = useSyncHubs((s) => s.hubs);
  const paired = useChat((s) => s.hubs);
  if (!board.sync || syncStatus(board, hubNameOf(board.sync.via, kept, paired))?.kind === "synced") return null;
  return <SyncBar board={board} now={now} />;
}

/** In place of a pane's board that isn't there (yet, or any more). */
function BoardPaneNote({ supported }: { supported: boolean | null }) {
  return (
    <div className="pane-note">
      <p className="muted small">
        {supported === false
          ? "This computer's hub keeps no boards. Update Desk to keep tickets here."
          : supported === null
            ? "Reading the board…"
            : "This board is no longer on this computer's hub."}
      </p>
    </div>
  );
}

function ColumnView({
  ids,
  on,
  col,
  count,
  all,
  waiting,
  line,
  shelfOpen,
  onShelf,
  dragged,
  onCardKey,
  register,
}: {
  ids: string;
  /** The column a narrow pane shows. */
  on: boolean;
  col: Column;
  count: number;
  all: Readonly<Record<string, Ticket>>;
  waiting: (t: Ticket) => boolean;
  /** Where the drop line is: before that card, at the end (null), or none. */
  line: string | null | undefined;
  shelfOpen: boolean;
  onShelf: () => void;
  dragged: { current: boolean };
  onCardKey: (t: Ticket, e: KeyboardEvent<HTMLElement>) => void;
  register: (id: string, el: HTMLElement | null) => void;
}) {
  const area = useRef<HTMLElement | null>(null);
  useDroppable({ id: `col:${col.state}`, type: "column", accept: "ticket", element: area, collisionPriority: 0 });
  const titleId = `${ids}-col-${col.state}-title`;
  return (
    <section ref={area} id={`${ids}-col-${col.state}`} className={`floor-card board-col ${on ? "board-col-on" : ""}`} aria-labelledby={titleId}>
      <div className="board-col-head">
        <h2 id={titleId} className="ov-label muted">
          {col.title}
        </h2>
        <span className="floor-time" aria-label={`${count} ticket${count === 1 ? "" : "s"}`}>
          {count}
        </span>
      </div>
      <ul className="board-cards" aria-labelledby={titleId}>
        {col.cards.map((t) => (
          <DraggableCard key={t.id} ticket={t} all={all} waiting={waiting(t)} lineBefore={line === t.id} dragged={dragged} onKey={onCardKey} register={register} />
        ))}
        {line === null && <li className="drop-line" aria-hidden="true" />}
        {col.shelf.length > 0 && (
          <li>
            <button type="button" className="link board-shelf" aria-expanded={shelfOpen} onClick={onShelf}>
              {shelfLabel(col.shelf.length, shelfOpen)}
            </button>
          </li>
        )}
        {shelfOpen && col.shelf.map((t) => <DraggableCard key={t.id} ticket={t} all={all} waiting={false} lineBefore={false} dragged={dragged} onKey={onCardKey} register={register} settled />)}
      </ul>
    </section>
  );
}

function DraggableCard({
  ticket,
  all,
  waiting,
  lineBefore,
  dragged,
  onKey,
  register,
  settled = false,
}: {
  ticket: Ticket;
  all: Readonly<Record<string, Ticket>>;
  waiting: boolean;
  lineBefore: boolean;
  dragged: { current: boolean };
  onKey: (t: Ticket, e: KeyboardEvent<HTMLElement>) => void;
  register: (id: string, el: HTMLElement | null) => void;
  settled?: boolean;
}) {
  const el = useRef<HTMLButtonElement | null>(null);
  const states = useContext(States);
  const plan = useContext(Plans).get(ticket.id);
  const openTicket = useContext(TicketOpener);
  // A dropped ticket comes back by Bring it back, never by landing in a column.
  const drag = useDraggable({ id: ticket.id, type: "ticket", element: el, disabled: ticket.state === "dropped" });
  useDroppable({ id: ticket.id, type: "ticket", accept: "ticket", element: el, collisionPriority: 1 });
  return (
    <>
      {lineBefore && <li className="drop-line" aria-hidden="true" />}
      <li className={drag.isDragSource ? "ghost" : undefined}>
        <TicketCard
          ticket={ticket}
          all={all}
          states={states}
          waiting={waiting}
          settled={settled}
          plan={plan}
          buttonRef={(b) => {
            el.current = b;
            register(ticket.id, b);
          }}
          onOpen={() => {
            if (dragged.current) return;
            openTicket(ticket.id);
          }}
          onKeyDown={(e) => onKey(ticket, e)}
        />
      </li>
    </>
  );
}

