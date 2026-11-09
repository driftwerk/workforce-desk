import { useState, type KeyboardEvent } from "react";
import { ChargeBadge } from "../crew/ChargeBadge";
import { useCharge } from "../crew/chargeStore";
import { lookOf } from "../floor/background";
import { useSessionName } from "../groups/names";
import { useHubLayout } from "../groups/hubLayout";
import { askMove, ticketSubject } from "../groups/move";
import { Menu } from "../ui/Menu";
import { useDesk } from "../hub/store";
import type { ActivityParty, Ticket } from "../hub/types";
import { useLocalAgent } from "../overview/people";
import { blockers, needsLine } from "./board";
import type { TicketState } from "../hub/types";

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

/** Who made a ticket that wasn't you, by their name here. */
const useMakerName = (who: ActivityParty): string => {
  const session = useSessionName(who.kind === "session" ? who.id : null, who.name);
  const agent = useLocalAgent(who.kind === "agent" ? who.id : null);
  return who.kind === "session" ? session : (agent?.name ?? who.name);
};

/** "acme-api added this", while it waits to be taken up. */
function Maker({ who }: { who: ActivityParty }) {
  return <span className="floor-item-what">{useMakerName(who)} added this</span>;
}

/** A quiet "by acme-api" once it's been taken up: its words stay theirs. */
function By({ who }: { who: ActivityParty }) {
  const name = useMakerName(who);
  return (
    <span className="board-by" title={`Written by ${name}`}>
      by {name}
    </span>
  );
}

/** One ticket on the board: its key, title, and what it waits on or who has
 *  it; drawn waiting when it waits on you, dashed while a session's or an
 *  agent's own, faint once settled. */
export function TicketCard({
  ticket: t,
  all,
  states,
  waiting,
  settled = false,
  plan,
  buttonRef,
  onOpen,
  onKeyDown,
}: {
  /** The goal of the boss's plan it is in, if it is in one. */
  plan?: string;
  ticket: Ticket;
  all: Readonly<Record<string, Ticket>>;
  /** Every ticket's state, worked out once for the board. */
  states: ReadonlyMap<string, TicketState>;
  waiting: boolean;
  settled?: boolean;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const written = t.createdBy.kind !== "you";
  const theirs = written && t.state === "backlog" && !t.assignee;
  const blocked = (t.state === "todo" || t.state === "doing") && blockers(t, states).length > 0;
  const needs = needsLine(t, all, states);
  const pr = t.links.find((l) => l.kind === "pr");
  // Being worked on: in Doing, its session working.
  const working = useDesk((s) => {
    const who = t.assignee;
    const session = who?.kind === "session" && t.state === "doing" ? s.sessions[who.id] : undefined;
    return session ? lookOf(session) === "working" : false;
  });
  const look = settled
    ? "board-card-settled"
    : waiting
      ? "board-card-waiting"
      : theirs
        ? "board-card-theirs"
        : working
          ? "board-card-working"
          : "";
  // Its right-click menu: moving it to another group's board.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const movable = useHubLayout((s) => s.layout !== null);
  return (
    <>
    <button
      ref={buttonRef}
      type="button"
      className={`floor-item board-card ${look}`}
      onContextMenu={
        movable
          ? (e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY });
            }
          : undefined
      }
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
        {written && !theirs && <By who={t.createdBy} />}
        {plan !== undefined && (
          <span className="chip board-plan-chip" title={plan ? `In the plan “${plan}”` : "In a plan"}>
            {plan || "Plan"}
          </span>
        )}
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
      {menu && (
        <Menu
          label={`${t.key ?? "Ticket"} options`}
          at={menu}
          entries={[{ kind: "item", label: "Move to group…", onSelect: () => askMove(ticketSubject(t)) }]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
