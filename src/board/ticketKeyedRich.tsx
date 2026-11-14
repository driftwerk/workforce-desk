import type { Directive, RichHost } from "@workforce/rich";
import { useMemo, type ReactNode } from "react";
import type { Ticket } from "../hub/types";
import { parseTicketLink } from "../shell/links";
import { DESK_RICH_HOST } from "../shell/richHost";
import { IssueChip } from "./IssueChip";
import { useBoard } from "./store";
import { SmartLink, TICKET_DIRECTIVES, ticketDirective } from "./ticketDirectives";
import { linkTicketKeys } from "./ticketKeys";

/** The site and issue key an `https` address to an issue names: Jira's
 *  `…/browse/PLT-875`, Linear's `…/issue/MAN-611/a-slug`. */
export const issueAddress = (href: string): string | null => {
  const m = /^https:\/\/([^/?#]+)\/(?:[^?#]*\/)?(?:browse|issue)\/([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})(?:[/?#]|$)/i.exec(href.trim());
  return m ? `${m[1]!.toLowerCase()}|${m[2]!.toUpperCase()}` : null;
};

/** Each synced ticket's id by its issue's site and key, built once per
 *  change of the tickets. */
const idsByIssue = new WeakMap<object, Map<string, string>>();
const issueIds = (tickets: Record<string, Ticket>): Map<string, string> => {
  let ids = idsByIssue.get(tickets);
  if (!ids) {
    ids = new Map();
    for (const o of Object.values(tickets)) {
      const at = o.external?.url ? issueAddress(o.external.url) : null;
      // Its address names it: an address that names another issue isn't its.
      if (at && at.endsWith(`|${o.external!.key.toUpperCase()}`)) ids.set(at, o.id);
    }
    idsByIssue.set(tickets, ids);
  }
  return ids;
};

/** The ticket here whose issue a link to `href` names: by its site and its
 *  key, since two sites can have the same keys. */
export const ticketAt = (href: string, tickets: Record<string, Ticket>): string | null => {
  const at = issueAddress(href);
  return at ? (issueIds(tickets).get(at) ?? null) : null;
};

/** The words a link was drawn with, when they're only text. */
const wordsOf = (children: ReactNode): string | null =>
  typeof children === "string" ? children : Array.isArray(children) && children.every((c) => typeof c === "string") ? children.join("") : null;

/** Desk's markdown host for a ticket's own text (its description, its
 *  comments): a link to a ticket on a board here, or to its issue, is drawn
 *  as that ticket's chip; what the hub writes as directives (a mention, a status, a date, a panel, a
 *  collapsible) is drawn as Desk draws it, and a file of the ticket's
 *  (`desk-file:`) is kept for the description to draw. */
export const TICKET_RICH_HOST = {
  ...DESK_RICH_HOST,
  imageSchemes: ["desk-file"],
  // Read when called: this module and the board's are in a cycle.
  directive: (d: Directive) => ticketDirective(d),
  directiveNames: TICKET_DIRECTIVES,
  link: (href: string, children: ReactNode) => {
    const tickets = useBoard.getState().tickets;
    const id = parseTicketLink(href) ?? ticketAt(href, tickets);
    return id && tickets[id] ? <IssueChip id={id}>{children}</IssueChip> : undefined;
  },
} satisfies RichHost;

/** A description's links: as {@link TICKET_RICH_HOST}'s, and a bare address
 *  (its words itself, as the hub writes a Jira smart link to a page) as a
 *  link chip. Only a description's: a comment's bare address stays a link. */
export const descriptionLink = (href: string, children: ReactNode): ReactNode => {
  const own = TICKET_RICH_HOST.link(href, children);
  if (own) return own;
  return /^https:\/\//i.test(href) && wordsOf(children)?.trim() === href ? <SmartLink href={href} /> : undefined;
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
