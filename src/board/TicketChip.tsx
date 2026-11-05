import { useMemo } from "react";
import type { Ticket } from "../hub/types";
import { keyParts } from "./board";
import { useBoard, useSessionTicket } from "./store";

/** A ticket's key as a chip: opens the ticket beside whatever is shown.
 *  `still` draws it without a button of its own, for rows that are one. */
export function TicketChip({ ticket, className = "", still = false }: { ticket: Pick<Ticket, "id" | "key" | "title">; className?: string; still?: boolean }) {
  if (!ticket.key) return null;
  if (still)
    return (
      <span className={`chip ticket-chip ${className}`} title={`${ticket.key} · ${ticket.title}`}>
        {ticket.key}
      </span>
    );
  return (
    <button
      type="button"
      className={`chip ticket-chip ${className}`}
      title={`${ticket.key} · ${ticket.title}`}
      aria-label={`Open ticket ${ticket.key}: ${ticket.title}`}
      // Inside something that drags or opens on its own: only the ticket opens.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        useBoard.getState().openTicket(ticket.id);
      }}
    >
      {ticket.key}
    </button>
  );
}

/** The chip of the ticket session `id` works on, when it has one. */
export function SessionTicketChip({ session, className = "", still = false }: { session: string; className?: string; still?: boolean }) {
  const t = useSessionTicket(session);
  return t ? <TicketChip ticket={t} className={className} still={still} /> : null;
}

/** The chip of the ticket an Activity row is about, while it's on a board. */
export function EventTicketChip({ id }: { id: string }) {
  const t = useBoard((s) => s.tickets[id]);
  return t ? <TicketChip ticket={t} className="ev-ticket" /> : null;
}

/** Text with the keys of tickets there are as their chips: `ACM-12`. */
export function TicketKeys({ text }: { text: string }) {
  const tickets = useBoard((s) => s.tickets);
  const byKey = useMemo(() => new Map(Object.values(tickets).flatMap((t) => (t.key ? [[t.key.toUpperCase(), t] as const] : []))), [tickets]);
  const parts = useMemo(() => keyParts(text, new Set(byKey.keys())), [text, byKey]);
  return (
    <>
      {parts.map((p, i) => (p.kind === "text" ? p.text : <TicketChip key={i} ticket={byKey.get(p.key)!} className="msg-ticket" />))}
    </>
  );
}
