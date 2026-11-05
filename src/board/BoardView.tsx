import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useChat } from "../chat/store";
import { useBoss } from "../crew/chargeStore";
import { waitsOnYou } from "../floor/background";
import { useNeedCounts } from "../floor/store";
import { agentItem, sessionItem } from "../groups/model";
import { PLUGINS, SENSORS, DragChip, MoreIcon, below, type Operation } from "../groups/rows";
import { useDesk } from "../hub/store";
import type { Ticket, TicketState } from "../hub/types";
import { useMinute } from "../floor/RightNow";
import { Menu, type MenuEntry } from "../ui/Menu";
import { BoardDialog, DeleteBoard } from "./BoardDialogs";
import { FILTERS, STATE_TITLE, anchored, statesOf, columns, keyOf, landing, lineAt, nudge, shelfLabel, snoozed, waitingOnYou, type BoardFilter, type Column, type Over } from "./board";
import { NewTicket } from "./NewTicket";
import { shownBoard, useBoard } from "./store";
import { TicketCard } from "./TicketCard";

/** Whether a ticket's session or agent waits on the person, by the Floor's
 *  own rule (its needs, else the session's state). */
export const useWaiting = (): ((t: Ticket) => boolean) => {
  const sessions = useDesk((s) => s.sessions);
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

/** Every ticket's state, worked out once for the board's cards. */
const States = createContext<ReadonlyMap<string, TicketState>>(new Map());

const KEYS: Record<string, "up" | "down" | "left" | "right"> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

/** The board: its five columns of tickets, filtered and searched; cards
 *  dragged (or moved with Alt+arrows) between and within columns. */
export function Board() {
  const supported = useBoard((s) => s.supported);
  const board = useBoard(shownBoard);
  const boards = useBoard((s) => s.boards);
  const all = useBoard((s) => s.tickets);
  const fail = useDesk((s) => s.fail);
  const boss = useBoss();
  const waiting = useWaiting();
  const now = useMinute();
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [q, setQ] = useState("");
  const [shelfOpen, setShelfOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [naming, setNaming] = useState<"new" | "rename" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [said, setSaid] = useState("");
  const menuButton = useRef<HTMLButtonElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());

  const mine = useMemo(() => (board ? Object.values(all).filter((t) => t.board === board.id) : []), [all, board]);
  const cols = useMemo(() => columns(mine, { filter, q, now, waiting }), [mine, filter, q, now, waiting]);
  const counts = useMemo(() => columns(mine, { filter: "all", q: "", now, waiting }), [mine, now, waiting]);
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
            <button type="button" className="btn btn-signal" onClick={() => setNaming("new")}>
              Make a board
            </button>
          </div>
        </section>
        {naming && <BoardDialog onClose={() => setNaming(null)} />}
      </main>
    );

  const menuEntries: MenuEntry[] = [
    ...Object.values(boards)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((b) => ({ kind: "item" as const, label: b.name, checked: b.id === board.id, onSelect: () => useBoard.getState().show(b.id) })),
    { kind: "separator" },
    { kind: "item", label: "New board…", onSelect: () => setNaming("new") },
    { kind: "item", label: "Rename board…", onSelect: () => setNaming("rename") },
    { kind: "item", label: "Delete board…", onSelect: () => setDeleting(true) },
  ];

  return (
    <main className="board" aria-label="Board">
      <header className="board-head">
        <h1 className="display">{/board$/i.test(board.name) ? board.name : `${board.name} board`}</h1>
        <span className="floor-time">{[board.prefix, boss?.name ? `run by ${boss.name}` : null].filter(Boolean).join(" · ")}</span>
        <button
          ref={menuButton}
          type="button"
          className="icon-btn-sm"
          aria-label="Boards"
          aria-haspopup="menu"
          title="Other boards, rename, delete"
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
        <label className="sr-only" htmlFor="board-search">
          Search tickets
        </label>
        <input
          id="board-search"
          className="board-search"
          value={q}
          placeholder={`Search or ${board.prefix ?? "ACM"}-12`}
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
      <States.Provider value={states}>
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
      />
      </States.Provider>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
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
      {naming && <BoardDialog board={naming === "rename" ? board : undefined} onClose={() => setNaming(null)} />}
      {deleting && <DeleteBoard board={board} count={mine.length} onClose={() => setDeleting(false)} />}
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
}: {
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
  const dragged = useRef(false);
  const overOf = (op: Operation): Over | null => {
    const { source, target } = op;
    if (!source || !target || source.type !== "ticket") return null;
    const id = String(target.id);
    if (id.startsWith("col:")) return { column: id.slice(4) as TicketState };
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
      <div className="board-cols">
        {cols.map((c, i) => (
          <ColumnView
            key={c.state}
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

function ColumnView({
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
  const titleId = `board-col-${col.state}`;
  return (
    <section ref={area} className="floor-card board-col" aria-labelledby={titleId}>
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
          buttonRef={(b) => {
            el.current = b;
            register(ticket.id, b);
          }}
          onOpen={() => {
            if (dragged.current) return;
            useBoard.getState().openTicket(ticket.id);
          }}
          onKeyDown={(e) => onKey(ticket, e)}
        />
      </li>
    </>
  );
}

