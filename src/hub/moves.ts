// Moving an item to another group, as the person who holds this computer's
// hub (boss-gaps W8, the hub's BH18): preview what the move does, read each
// handover note while the boss it leaves drafts it, and make the move as
// previewed. These routes are the holder's alone, as deciding a need is, so
// they go over the paired path as the person (`deskCall`), never through
// the broker, whose token the hub refuses for them.

import { deskCall } from "./client";
import type { HubRef } from "./net";

/** What moves: a session or ticket by its id, a room by its id, or a boss
 *  (the agent that oversees a group) by its agent id. */
export type MoveItem =
  | { kind: "session"; id: string }
  | { kind: "ticket"; id: string }
  | { kind: "room"; id: string }
  | { kind: "boss"; id: string };

/** The person's choices: whether a session's ticket goes along, whether its
 *  boss lets it go rather than hand it on, and whether a boss replaces the
 *  one its new group has. */
export interface MoveChoices {
  ticketGoes: boolean;
  release: boolean;
  replace: boolean;
}

export const NO_CHOICES: MoveChoices = { ticketGoes: false, release: false, replace: false };

/** One effect of a move, with what the dialog says of it. `kind` says only
 *  whether it carries something along or leaves it where it is; `text` is
 *  the hub's words, shown as they come. */
export interface MoveEffect {
  kind:
    | "charge_to"
    | "release"
    | "stays_unassigned"
    | "ticket_goes"
    | "leaves_plan"
    | "unassigned"
    | "ledger_stays"
    | "needs_kept"
    | "budget_follows"
    | "asks_withdrawn"
    | "replaces"
    | "asks_to_replace"
    | "passes_to_main"
    | "left_with_no_boss"
    | "memory_stays"
    | "handover"
    | "tell"
    | "refused";
  text: string;
  /** `handover`: the boss (agent id) it is from (`desk` for Desk's facts)
   *  and to; `charge_to`, `replaces`, `asks_to_replace`: the boss. */
  from?: string;
  to?: string;
  boss?: string;
  synced?: boolean;
}

/** Who wrote a note: the boss the item leaves, or Desk from the facts. */
export interface Drafter {
  kind: "agent" | "session" | "manager" | "you" | "desk";
  id: string;
  name: string;
}

/** A handover note as the dialog shows it. */
export interface Handover {
  id: string;
  /** What it is about: the item's key (`session:<id>`), or `plan:<id>`. */
  item: string;
  fromGroup: string | null;
  toGroup: string | null;
  fromBoss: string | null;
  toBoss: string | null;
  note: string;
  draftedBy: Drafter;
  edited: boolean;
  state: "draft" | "delivered" | "discarded";
  /** Its old boss is still writing it: the note may change. */
  drafting: boolean;
}

/** What a move would do, for the person to confirm. */
export interface MovePreview {
  id: string;
  item: MoveItem;
  from: string | null;
  to: string | null;
  choices: MoveChoices;
  effects: MoveEffect[];
  /** Why it can't be made as it is, when it can't. */
  blocked: string | null;
  /** The item's own note, when it has one. */
  handover: Handover | null;
  /** Every note: a boss's plans have one each. */
  handovers: Handover[];
  expiresAt: string;
}

/** What a move did. */
export interface MoveDone {
  effects: MoveEffect[];
  delivered: Handover[];
  /** What didn't go as it should, in plain words. */
  problems: string[];
}

/** A move as the person makes it: each note exactly as they read it. */
export interface MoveCommit {
  preview: string;
  choices: MoveChoices;
  note?: string;
  notes: { id: string; note: string }[];
}

/** The longest note the hub takes. */
export const MAX_NOTE = 4000;

/** The key a handover names its own item by. */
export const itemKey = (item: MoveItem): string => `${item.kind}:${item.id}`;

/** Moves on hub `hub`, as the person. */
export const movesOf = (hub: HubRef) => ({
  preview: (item: MoveItem, to: string | null, choices: MoveChoices): Promise<MovePreview> =>
    deskCall(hub, "POST", "/api/desk/moves/preview", { item, to, choices }),
  commit: (c: MoveCommit): Promise<MoveDone> => deskCall(hub, "POST", "/api/desk/moves", c),
  handover: (id: string): Promise<Handover> => deskCall(hub, "GET", `/api/desk/handovers/${encodeURIComponent(id)}`),
});

/** What a preview's notes are sent as: the item's own in `note`, every
 *  other by its id, each as `text` has it now. */
export const commitOf = (p: MovePreview, text: (h: Handover) => string): MoveCommit => {
  const own = p.handovers.find((h) => h.item === itemKey(p.item));
  return {
    preview: p.id,
    choices: p.choices,
    ...(own ? { note: text(own) } : {}),
    notes: p.handovers.filter((h) => h !== own).map((h) => ({ id: h.id, note: text(h) })),
  };
};

/** Whether a preview changes anything past the sidebar: none within one
 *  boss's scope. */
export const crosses = (p: MovePreview): boolean => p.effects.length > 0 || !!p.blocked;
