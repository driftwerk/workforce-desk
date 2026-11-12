import { useMemo } from "react";
import type { Ticket } from "../hub/types";
import { keyParts } from "./board";
import { useBoard, useSessionTicket, useTicketKeys } from "./store";

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

/** Whether `name` begins with ticket key `key` (`ACM-12 Fix the flaky`). */
export const namesKey = (name: string, key: string): boolean => {
  const n = name.trimStart().toUpperCase();
  const k = key.toUpperCase();
  return n.startsWith(k) && !/[A-Z0-9]/.test(n.charAt(k.length));
};

/** The chip of the ticket session `id` works on, when it has one. */
export function SessionTicketChip({ session, className = "", still = false, name }: { session: string; className?: string; still?: boolean; name?: string }) {
  const t = useSessionTicket(session);
  // A name that already starts with the key says it.
  if (t?.key && name && namesKey(name, t.key)) return null;
  return t ? <TicketChip ticket={t} className={className} still={still} /> : null;
}

/** The chip of the ticket an Activity row is about, while it's on a board. */
export function EventTicketChip({ id }: { id: string }) {
  const t = useBoard((s) => s.tickets[id]);
  return t ? <TicketChip ticket={t} className="ev-ticket" /> : null;
}

/** Text with the keys of tickets there are as their chips: `ACM-12`. */
export function TicketKeys({ text }: { text: string }) {
  const byKey = useTicketKeys();
  const parts = useMemo(() => keyParts(text, new Set(byKey.keys())), [text, byKey]);
  return (
    <>
      {parts.map((p, i) => (p.kind === "text" ? p.text : <TicketChip key={i} ticket={byKey.get(p.key)!} className="msg-ticket" />))}
    </>
  );
}
