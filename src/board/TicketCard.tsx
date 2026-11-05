import type { KeyboardEvent } from "react";
import { ChargeBadge } from "../crew/ChargeBadge";
import { useCharge } from "../crew/chargeStore";
import { lookOf } from "../floor/background";
import { useSessionName } from "../groups/names";
import { useDesk } from "../hub/store";
import type { ActivityParty, Ticket } from "../hub/types";
import { useLocalAgent } from "../overview/people";
import { blockers, needsLine } from "./board";

/** Who has a ticket, as a card or the ticket's panel says it: their dot,
 *  their name, and that a boss runs them or that they wait on you. */
export function Assignee({ who, waiting }: { who: ActivityParty; waiting: boolean }) {
  const session = useDesk((s) => (who.kind === "session" ? s.sessions[who.id] : undefined));
  const sessionName = useSessionName(who.kind === "session" ? who.id : null, who.name);
  const agent = useLocalAgent(who.kind === "agent" ? who.id : null);
  const charge = useCharge(who.kind === "session" ? who.id : null);
  const name = who.kind === "session" ? sessionName : who.kind === "agent" ? (agent?.name ?? who.name) : who.kind === "you" ? "You" : who.name;
  const look = session ? lookOf(session) : "idle";
  return (
    <span className="board-who">
      <span className={`dot dot-${look}`} aria-hidden="true" />
      <span className={who.kind === "session" ? "mono board-who-name" : "board-who-name"}>{name}</span>
      {waiting && session && (session.state === "blocked" || session.state === "asking") ? (
        <span className="state-blocked">{session.state === "asking" ? "asked you something" : "needs you"}</span>
      ) : (
        <ChargeBadge charge={charge} />
      )}
    </span>
  );
}

/** Who made a ticket that wasn't you: "acme-api added this". */
function Maker({ who }: { who: ActivityParty }) {
  const name = useSessionName(who.kind === "session" ? who.id : null, who.name);
  return <span className="floor-item-what">{who.kind === "session" ? name : who.name} added this</span>;
}

/** One ticket on the board: its key, title, and what it waits on or who has
 *  it; drawn waiting when it waits on you, dashed while a session's or an
 *  agent's own, faint once settled. */
export function TicketCard({
  ticket: t,
  all,
  waiting,
  settled = false,
  buttonRef,
  onOpen,
  onKeyDown,
}: {
  ticket: Ticket;
  all: Readonly<Record<string, Ticket>>;
  waiting: boolean;
  settled?: boolean;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const theirs = t.createdBy.kind !== "you" && t.state === "backlog" && !t.assignee;
  const states = new Map(Object.values(all).map((o) => [o.id, o.state] as const));
  const blocked = (t.state === "todo" || t.state === "doing") && blockers(t, states).length > 0;
  const needs = needsLine(t, all);
  const pr = t.links.find((l) => l.kind === "pr");
  const look = settled ? "board-card-settled" : waiting ? "board-card-waiting" : theirs ? "board-card-theirs" : "";
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`floor-item board-card ${look}`}
      aria-label={`${t.key ?? "Ticket"}: ${t.title}`}
      aria-roledescription="ticket"
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
      title={t.state === "dropped" ? "Dropped" : undefined}
      onClick={onOpen}
      onKeyDown={onKeyDown}
    >
      <span className="board-card-head">
        <span className="mono board-key">{t.key}</span>
        {t.pinned && <span className="board-pinned">Pinned</span>}
        {t.state === "dropped" && <span className="faint small">Dropped</span>}
      </span>
      <b className="board-title">{t.title}</b>
      {pr?.kind === "pr" && (
        <span className="board-card-meta">
          <span className="chip chip-live">PR #{pr.number}</span>
          {t.assignee && <Assignee who={t.assignee} waiting={waiting} />}
        </span>
      )}
      {!pr && t.assignee && !settled && (
        <span className="board-card-meta">
          <Assignee who={t.assignee} waiting={waiting} />
        </span>
      )}
      {needs && !settled && <span className={blocked ? "floor-item-what state-blocked" : "floor-item-what"}>{blocked ? needs.replace(/^needs/, "Blocked by") : needs}</span>}
      {theirs && <Maker who={t.createdBy} />}
    </button>
  );
}
