import { create } from "zustand";
import { deskListeners, useDesk } from "../hub/store";
import type { AssignTo, Board, DeskEvent, NewTicket, Ticket, TicketMove, TicketPatch } from "../hub/types";
import { moved } from "./board";

interface BoardState {
  boards: Record<string, Board>;
  tickets: Record<string, Ticket>;
  /** The hub keeps boards: false once it said it doesn't (an older one). */
  supported: boolean | null;
  /** The board shown, by id; null shows the first. */
  shown: string | null;
  /** The ticket open in its panel. */
  open: string | null;
  /** Reads every board and its tickets; read again (`tries` more times)
   *  when a change came meanwhile. */
  load: (tries?: number) => Promise<void>;
  show: (board: string) => void;
  openTicket: (id: string | null) => void;
  /** A ticket the hub announced. */
  heard: (t: Ticket) => void;
  /** Reads ticket `id` again, kept unless it changed meanwhile. */
  fetched: (id: string) => Promise<void>;
  createBoard: (name: string, prefix?: string) => Promise<Board>;
  createTicket: (t: NewTicket) => Promise<Ticket>;
  /** Moves a ticket at once, then as the hub placed it. Refused, it is
   *  read again (unless it changed meanwhile) and the refusal thrown in the
   *  hub's words. An answer older than a change heard since is dropped. */
  move: (id: string, move: TicketMove) => Promise<void>;
  edit: (id: string, patch: TicketPatch) => Promise<void>;
  assign: (id: string, to: AssignTo) => Promise<void>;
  need: (id: string, other: string, needs: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** Bumped by each change heard: a read that began before it is older. */
let heardCount = 0;
/** Each ticket's changes heard from the hub (its events), by id: an answer
 *  to a request made before the last of them is older than what's kept. */
const heardOf = new Map<string, number>();
const mark = (id: string): number => heardOf.get(id) ?? 0;
const bump = (id: string) => {
  heardCount++;
  heardOf.set(id, mark(id) + 1);
};

const hubNow = () => useDesk.getState().hub;

const byId = <T extends { id: string }>(list: readonly T[]): Record<string, T> => Object.fromEntries(list.map((x) => [x.id, x]));

/** How many times a load reads again while changes keep coming before it
 *  keeps what it read, with what was heard meanwhile on top. */
const LOAD_TRIES = 3;

export const useBoard = create<BoardState>((set, get) => {
  /** The hub's answer about `t`, kept unless the ticket changed since the
   *  request went (`since`): then what was heard is newer. */
  const answered = (t: Ticket, since: number) => {
    if (mark(t.id) !== since) return;
    heardCount++;
    set((s) => ({ tickets: { ...s.tickets, [t.id]: t } }));
  };
  /** Runs a request about ticket `id` and keeps its answer as above. */
  const ask = async (id: string, request: () => Promise<Ticket>): Promise<void> => {
    const since = mark(id);
    answered(await request(), since);
  };
  return {
    boards: {},
    tickets: {},
    supported: null,
    shown: null,
    open: null,
    load: async (tries = LOAD_TRIES) => {
      const hub = hubNow();
      if (!hub) return;
      const was = heardCount;
      const before = new Map(heardOf);
      try {
        const boards = await hub.boards();
        if (hubNow() !== hub) return;
        if (boards === null) {
          set({ supported: false, boards: {}, tickets: {} });
          return;
        }
        const lists = await Promise.all(boards.map((b) => hub.tickets(b.id)));
        // Another hub by now: what was read is someone else's.
        if (hubNow() !== hub) return;
        // A change heard meanwhile: read again while that helps, then keep
        // what was read with what was heard since on top.
        if (heardCount !== was && tries > 1) return get().load(tries - 1);
        set((s) => {
          const read = byId(lists.flat());
          for (const [id, n] of heardOf) {
            if ((before.get(id) ?? 0) === n) continue;
            if (s.tickets[id]) read[id] = s.tickets[id]!;
            else delete read[id];
          }
          return { supported: true, boards: { ...byId(boards), ...(heardCount !== was ? keptBoards(s.boards, boards) : {}) }, tickets: read };
        });
      } catch {
        // Kept as last read; the next snapshot reads them again.
      }
    },
    show: (shown) => set({ shown }),
    openTicket: (open) => set({ open }),
    heard: (t) => {
      bump(t.id);
      set((s) => ({ tickets: { ...s.tickets, [t.id]: t } }));
    },
    fetched: async (id) => {
      const hub = hubNow();
      if (hub) await ask(id, () => hub.ticket(id));
    },
    createBoard: async (name, prefix) => {
      const hub = hubNow();
      if (!hub) throw new Error("This computer's hub isn't running.");
      const b = await hub.createBoard(prefix ? { name, prefix } : { name });
      heardCount++;
      set((s) => ({ boards: { ...s.boards, [b.id]: b }, shown: b.id, supported: true }));
      return b;
    },
    createTicket: async (t) => {
      const hub = hubNow();
      if (!hub) throw new Error("This computer's hub isn't running.");
      const made = await hub.createTicket(t);
      if (!get().tickets[made.id]) answered(made, mark(made.id));
      return get().tickets[made.id] ?? made;
    },
    move: async (id, mv) => {
      const hub = hubNow();
      const was = get().tickets[id];
      if (!hub || !was) return;
      const since = mark(id);
      const shown = moved(was, mv, get().tickets, new Date().toISOString());
      heardCount++;
      set((s) => ({ tickets: { ...s.tickets, [id]: shown } }));
      try {
        answered(await hub.moveTicket(id, mv), since);
      } catch (e) {
        // Refused: the ticket as the hub has it now, unless something newer
        // came meanwhile (the move shown is then already gone).
        const fresh = await hub.ticket(id).catch(() => null);
        set((s) => (s.tickets[id] === shown ? { tickets: { ...s.tickets, [id]: fresh ?? was } } : s));
        throw e;
      }
    },
    edit: async (id, patch) => {
      const hub = hubNow();
      if (hub) await ask(id, () => hub.editTicket(id, patch));
    },
    assign: async (id, to) => {
      const hub = hubNow();
      if (hub) await ask(id, () => hub.assignTicket(id, to));
    },
    need: async (id, other, needs) => {
      const hub = hubNow();
      if (hub) await ask(id, () => hub.needTicket(id, other, needs));
    },
    remove: async (id) => {
      const hub = hubNow();
      if (!hub) return;
      await hub.deleteTicket(id);
      forget(id);
    },
  };
});

/** The boards heard of while a load read them: those it didn't read are
 *  newer than it. */
const keptBoards = (now: Readonly<Record<string, Board>>, read: readonly Board[]): Record<string, Board> =>
  Object.fromEntries(Object.entries(now).filter(([id]) => !read.some((b) => b.id === id)));

const forget = (id: string) => {
  bump(id);
  useBoard.setState((s) => {
    if (!(id in s.tickets)) return s;
    const { [id]: _, ...rest } = s.tickets;
    return { tickets: rest, open: s.open === id ? null : s.open };
  });
};

/** The board shown: the one chosen, else the first made. */
export const shownBoard = (s: Pick<BoardState, "boards" | "shown">): Board | null => {
  const all = Object.values(s.boards).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (s.shown ? s.boards[s.shown] : undefined) ?? all[0] ?? null;
};

/** The ticket a session works on: the one given to it that isn't finished,
 *  newest first; else the newest linked to it. */
export const ticketOfSession = (tickets: Readonly<Record<string, Ticket>>, session: string): Ticket | null =>
  ticketIndex(tickets).bySession.get(session) ?? null;

export interface TicketIndex {
  /** Each session's ticket, as `ticketOfSession` says. */
  bySession: ReadonlyMap<string, Ticket>;
  /** Each ticket by its key, upper-cased. */
  byKey: ReadonlyMap<string, Ticket>;
}

let indexed: { tickets: Readonly<Record<string, Ticket>>; index: TicketIndex } | null = null;

/** The tickets by session and by key, worked out once per change to them
 *  and shared by every chip and message that asks. */
export const ticketIndex = (tickets: Readonly<Record<string, Ticket>>): TicketIndex => {
  if (indexed?.tickets === tickets) return indexed.index;
  const assigned = new Map<string, Ticket>();
  const linked = new Map<string, Ticket>();
  const byKey = new Map<string, Ticket>();
  for (const t of Object.values(tickets).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (t.key) byKey.set(t.key.toUpperCase(), t);
    if (t.state === "done" || t.state === "dropped") continue;
    if (t.assignee?.kind === "session" && !assigned.has(t.assignee.id)) assigned.set(t.assignee.id, t);
    for (const l of t.links) if (l.kind === "session" && !linked.has(l.session)) linked.set(l.session, t);
  }
  const index = { bySession: new Map([...linked, ...assigned]), byKey };
  indexed = { tickets, index };
  return index;
};

/** The ticket session `id` works on, kept current. */
export const useSessionTicket = (id: string | null | undefined): Ticket | null =>
  useBoard((s) => (id ? (ticketIndex(s.tickets).bySession.get(id) ?? null) : null));

/** The tickets by their keys, kept current. */
export const useTicketKeys = (): ReadonlyMap<string, Ticket> => useBoard((s) => ticketIndex(s.tickets).byKey);

const onEvent = (e: DeskEvent) => {
  const s = useBoard.getState();
  switch (e.type) {
    case "ticket":
      s.heard(e.ticket);
      break;
    case "ticketRemoved":
      forget(e.id);
      break;
    case "board":
      heardCount++;
      useBoard.setState((st) => ({ boards: { ...st.boards, [e.board.id]: e.board }, supported: true }));
      break;
    case "boardRemoved":
      heardCount++;
      useBoard.setState((st) => {
        const { [e.id]: _, ...boards } = st.boards;
        const tickets = Object.fromEntries(Object.entries(st.tickets).filter(([, t]) => t.board !== e.id));
        const open = st.open && tickets[st.open] ? st.open : null;
        return { boards, tickets, open, shown: st.shown === e.id ? null : st.shown };
      });
      break;
    // Read again on every snapshot (a hub that had none may have been
    // updated meanwhile).
    case "snapshot":
      void s.load();
      break;
    default:
      break;
  }
};
deskListeners.add(onEvent);

// Another hub (or none): what the last one said is no longer so.
useDesk.subscribe((now, before) => {
  if (now.hub !== before.hub) useBoard.setState({ boards: {}, tickets: {}, supported: null, open: null });
});
