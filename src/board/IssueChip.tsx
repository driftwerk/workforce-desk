import type { ReactNode } from "react";
import { STATE_TITLE } from "./board";
import { IssueGlyph, TypeGlyph } from "./cardFacts";
import { useOpenTicket } from "./opener";
import { useBoard } from "./store";
import { stateTone } from "./TicketSections";

/** A ticket named in a description or a comment, inline as its issue's
 *  chip: its type (or Linear state), its key, what the link said when that
 *  was more than the key, and its state. It reads the ticket from the board
 *  itself, so its state stays current; gone from the board meanwhile, it's
 *  the link's text. */
export function IssueChip({ id, children }: { id: string; children: ReactNode }) {
  const t = useBoard((s) => s.tickets[id]);
  const open = useOpenTicket();
  if (!t) return <>{children}</>;
  const key = t.external?.key ?? t.key;
  const text = typeof children === "string" ? children : Array.isArray(children) && children.every((c) => typeof c === "string") ? children.join("") : null;
  const said = text !== null && text.trim() !== key ? text.trim() : null;
  const d = t.external?.details;
  const state = d?.remoteState ?? STATE_TITLE[t.state];
  const done = t.state === "done" || d?.stateKind === "completed";
  return (
    <button type="button" className="ticket-issue-chip" onClick={() => open(t.id)} title={t.title} aria-label={`Open ${key}: ${t.title}, ${state}`}>
      {/* A Desk ticket has no type of its own: drawn as a sub-task, as the mockup draws it. */}
      {d?.kind || d?.stateKind ? <IssueGlyph details={d} size={12} /> : <TypeGlyph kind="Sub-task" level={-1} size={12} />}
      <span className="ticket-issue-chip-key">{key}</span>
      {said && <span className="ticket-issue-chip-text">{said}</span>}
      <span className={`ticket-issue-chip-state ${stateTone(state, done)}`}>{state}</span>
    </button>
  );
}
