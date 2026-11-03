import type { ActivityParty, LineMessage, Session } from "../hub/types";

export const S1: ActivityParty = { kind: "session", id: "s1", name: "acme-web", engine: "claude", origin: "desk" };
export const S2: ActivityParty = { kind: "session", id: "s2", name: "acme-api", engine: "codex", origin: "desk" };
export const YOU: ActivityParty = { kind: "you", id: "you", name: "You" };
export const DESK: ActivityParty = { kind: "manager", id: "sarah", name: "Sarah" };

/** A message on a line, as the hub sends it. */
export const msg = (more: Partial<LineMessage> = {}): LineMessage => ({
  id: "m1",
  at: "2026-11-03T10:00:00Z",
  from: S1,
  to: DESK,
  kind: "ask",
  text: "Which port does the test database use?",
  inReplyTo: null,
  hop: 1,
  delivery: "delivered",
  asked: "open",
  escalation: null,
  deliveredAt: "2026-11-03T10:00:00Z",
  updatedAt: "2026-11-03T10:00:00Z",
  ...more,
});

/** A Claude Code session on Desk's line. */
export const lined = (more: Partial<Session> = {}): Session => ({
  id: "s1",
  engine: "claude",
  name: "acme-web",
  goal: "",
  cwd: "/work/acme-web",
  branch: null,
  origin: "desk",
  state: "idle",
  live: true,
  cliSessionId: null,
  lastPrompt: null,
  lastReply: null,
  currentTool: null,
  pending: null,
  approvals: "desk",
  caps: {
    state: "hooks",
    approvals: "desk",
    resume: "byId",
    interrupt: "keys",
    plan: "claude",
    line: "submit",
    steer: "paste",
    notes: [],
  },
  createdAt: "2026-11-03T09:00:00Z",
  updatedAt: "2026-11-03T09:00:00Z",
  ...more,
});
