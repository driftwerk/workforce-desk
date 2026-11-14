import { useMemo, type ReactNode } from "react";
import type { Ticket } from "../hub/types";
import { parseTicketLink } from "../shell/links";
import { DESK_RICH_HOST } from "../shell/richHost";
import { IssueChip } from "./IssueChip";
import { useBoard } from "./store";
import { linkTicketKeys } from "./ticketKeys";

/** Desk's markdown host for a ticket's own text (its description, its
 *  comments): a link to a ticket on a board here is drawn as that ticket's
 *  chip. */
export const TICKET_RICH_HOST = {
  ...DESK_RICH_HOST,
  link: (href: string, children: ReactNode) => {
    const id = parseTicketLink(href);
    return id && useBoard.getState().tickets[id] ? <IssueChip id={id}>{children}</IssueChip> : undefined;
  },
};

/** Each board's ticket keys and ids, built once per change of the tickets
 *  and shared by every text drawn. */
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

/** Text with each key of a ticket on the same board made a link to it, so
 *  it's drawn as that ticket's chip. Only for drawing: what's edited and
 *  sent stays the text as written. */
export function useKeyedBody(text: string, board: string | undefined): string {
  const tickets = useBoard((s) => s.tickets);
  return useMemo(() => {
    if (!board) return text;
    const ids = boardKeys(tickets, board);
    return ids.size ? linkTicketKeys(text, (k) => ids.get(k)) : text;
  }, [text, board, tickets]);
}
