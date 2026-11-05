import type { ActivityParty, Board, Ticket } from "../hub/types";

export const YOU: ActivityParty = { kind: "you", id: "you", name: "You" };
export const WEB: ActivityParty = { kind: "session", id: "s-web", name: "acme-web", engine: "claude" };
export const API: ActivityParty = { kind: "session", id: "s-api", name: "acme-api", engine: "claude" };

export const ACME: Board = { id: "b-acme", name: "Acme", group: null, prefix: "ACM", createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-01T09:00:00Z" };

/** A ticket on Acme's board, as the hub sends it. */
export const ticket = (number: number, over: Partial<Ticket> = {}): Ticket => ({
  id: `t${number}`,
  board: ACME.id,
  number,
  title: `Ticket ${number}`,
  body: "",
  state: "backlog",
  rank: number * 1024,
  assignee: null,
  needs: [],
  links: [],
  createdBy: YOU,
  pinned: false,
  snoozedUntil: null,
  stateAt: "2026-11-05T09:00:00Z",
  createdAt: "2026-11-05T09:00:00Z",
  updatedAt: "2026-11-05T09:00:00Z",
  key: `ACM-${number}`,
  ready: false,
  blockers: [],
  settled: false,
  snoozed: false,
  ...over,
});
