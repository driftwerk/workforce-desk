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
  /** A ticket the hub announced, or answered with. */
  heard: (t: Ticket) => void;
  createBoard: (name: string, prefix?: string) => Promise<Board>;
  createTicket: (t: NewTicket) => Promise<Ticket>;
  /** Moves a ticket at once, then as the hub placed it; put back as it was
   *  when the hub refuses (the refusal is thrown in its words). */
  move: (id: string, move: TicketMove) => Promise<void>;
  edit: (id: string, patch: TicketPatch) => Promise<void>;
  assign: (id: string, to: AssignTo) => Promise<void>;
  need: (id: string, other: string, needs: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** Bumped by each change heard: a read that began before it is older. */
let heardCount = 0;

const hubNow = () => useDesk.getState().hub;

const byId = <T extends { id: string }>(list: readonly T[]): Record<string, T> => Object.fromEntries(list.map((x) => [x.id, x]));

export const useBoard = create<BoardState>((set, get) => ({
  boards: {},
  tickets: {},
  supported: null,
  shown: null,
  open: null,
  load: async (tries = 2) => {
    const hub = hubNow();
    if (!hub) return;
    const was = heardCount;
    try {
      const boards = await hub.boards();
      if (boards === null) {
        if (hubNow() === hub) set({ supported: false, boards: {}, tickets: {} });
        return;
      }
      const lists = await Promise.all(boards.map((b) => hub.tickets(b.id)));
      // Another hub by now, or a change heard since: what was read is older.
      if (hubNow() !== hub) return;
      if (heardCount !== was) return tries > 0 ? get().load(tries - 1) : undefined;
      set({ supported: true, boards: byId(boards), tickets: byId(lists.flat()) });
    } catch {
      // Kept as last read; the next snapshot reads them again.
    }
  },
  show: (shown) => set({ shown }),
  openTicket: (open) => set({ open }),
  heard: (t) => {
    heardCount++;
    set((s) => ({ tickets: { ...s.tickets, [t.id]: t } }));
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
    get().heard(made);
    return made;
  },
  move: async (id, mv) => {
    const hub = hubNow();
    const was = get().tickets[id];
    if (!hub || !was) return;
    heardCount++;
    set((s) => ({ tickets: { ...s.tickets, [id]: moved(was, mv, s.tickets, new Date().toISOString()) } }));
    try {
      get().heard(await hub.moveTicket(id, mv));
    } catch (e) {
      set((s) => (s.tickets[id] ? { tickets: { ...s.tickets, [id]: was } } : s));
      throw e;
    }
  },
  edit: async (id, patch) => {
    const hub = hubNow();
    if (hub) get().heard(await hub.editTicket(id, patch));
  },
  assign: async (id, to) => {
    const hub = hubNow();
    if (hub) get().heard(await hub.assignTicket(id, to));
  },
  need: async (id, other, needs) => {
    const hub = hubNow();
    if (hub) get().heard(await hub.needTicket(id, other, needs));
  },
  remove: async (id) => {
    const hub = hubNow();
    if (!hub) return;
    await hub.deleteTicket(id);
    forget(id);
  },
}));

const forget = (id: string) => {
  heardCount++;
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
export const ticketOfSession = (tickets: Readonly<Record<string, Ticket>>, session: string): Ticket | null => {
  const all = Object.values(tickets).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const open = (t: Ticket) => t.state !== "done" && t.state !== "dropped";
  return (
    all.find((t) => open(t) && t.assignee?.kind === "session" && t.assignee.id === session) ??
    all.find((t) => open(t) && t.links.some((l) => l.kind === "session" && l.session === session)) ??
    null
  );
};

/** The ticket session `id` works on, kept current. */
export const useSessionTicket = (id: string | null | undefined): Ticket | null => useBoard((s) => (id ? ticketOfSession(s.tickets, id) : null));

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
