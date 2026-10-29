export type Engine = "claude" | "codex";

export type SessionState =
  | "starting"
  | "working"
  | "blocked"
  | "done"
  | "idle"
  | "interrupted"
  | "stopped"
  | "closed";

export type Origin = "desk" | "external";

export interface PendingApproval {
  id: string;
  tool: string;
  detail: string;
  since: string;
  /** False when the terminal is the one asking. */
  answerable: boolean;
}

export interface Session {
  id: string;
  engine: Engine;
  name: string;
  goal: string;
  cwd: string;
  branch: string | null;
  origin: Origin;
  state: SessionState;
  live: boolean;
  cliSessionId: string | null;
  lastPrompt: string | null;
  lastReply: string | null;
  currentTool: string | null;
  pending: PendingApproval | null;
  approvals: "desk" | "terminal";
  /** The Desk terminal it runs in, when it was started there by hand and
   *  Desk's hooks registered it (a tracked terminal). */
  terminalId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewSession {
  engine: Engine;
  name: string;
  cwd: string;
  goal?: string;
  worktree?: string;
  prompt?: string;
  approvals?: "desk" | "terminal";
}

/** A login shell the hub hosts for one of Desk's grid panes. */
export interface TerminalInfo {
  id: string;
  /** Where its shell is now, when the hub can tell. */
  cwd: string | null;
  /** The shell's process id, for seeing what runs in it. */
  pid: number | null;
  /** The session running in it now, once Desk's hooks have registered one. */
  sessionId?: string | null;
}

export interface NewTerminal {
  cwd?: string;
  cols?: number;
  rows?: number;
  /** Added to the shell's environment (the plugin directory Claude Code
   *  loads Desk's hooks from). */
  env?: Record<string, string>;
}

export interface RestoreOffer {
  sessions: Session[];
}

export interface RoomMemberRef {
  hub: string;
  agent: string;
}

export interface Room {
  id: string;
  slug: string;
  name: string;
  members: RoomMemberRef[];
  defaultMember: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  threadId: string | null;
  /** `you`, `desk`, or a member's `hub/agent`. */
  author: string;
  content: string;
  hop: number;
  createdAt: string;
}

export type DeskEvent =
  | { type: "snapshot"; sessions: Session[]; restore: Session[]; rooms: Room[] }
  | { type: "session"; session: Session }
  | { type: "removed"; id: string }
  | { type: "room"; room: Room }
  | { type: "roomRemoved"; id: string }
  | { type: "roomMessage"; message: RoomMessage }
  | { type: "activity"; event: ActivityEvent }
  /** A key of Desk's restorable state changed on the hub (null: removed). */
  | { type: "state"; key: string; value: unknown };

export type Decision = "allow" | "deny" | "terminal";

// ── The crew overview: activity, the overview, the manager ────────────────

/** Who or what an activity event is by or about. */
export interface ActivityParty {
  kind: "agent" | "session" | "manager" | "you";
  id: string;
  name: string;
  engine?: Engine | null;
  origin?: Origin | null;
}

export type ActivityKind =
  | "started"
  | "working"
  | "needs_you"
  | "question"
  | "answered"
  | "finished"
  | "failed"
  | "limit"
  | "quiet"
  | "stopped"
  | "resumed"
  | "restarted"
  | "nudged"
  | "approved"
  | "denied"
  | "suggested"
  | "dismissed"
  | "summary"
  | "assigned";

/** Something that happened on the crew, as the hub recorded it. */
export interface ActivityEvent {
  id: string;
  at: string;
  kind: ActivityKind;
  /** Who did it. */
  actor: ActivityParty;
  /** What it is about; absent for a summary. */
  subject?: ActivityParty | null;
  text: string;
  /** Why, for the overseer's own actions. */
  reason?: string | null;
  suggestionId?: string | null;
  approvalId?: string | null;
}

export type ActivityFilter = "all" | "needs_you" | "manager";

export interface ActivityPage {
  /** Newest first. */
  events: ActivityEvent[];
  more: boolean;
}

export type OverviewState = "needs_you" | "working" | "quiet" | "idle" | "done" | "failed" | "stopped";

/** An agent or a session, as the overview shows it. */
export interface OverviewItem {
  kind: "session" | "agent";
  id: string;
  name: string;
  engine?: Engine | null;
  origin?: Origin | null;
  state: OverviewState;
  task?: string | null;
  detail?: string | null;
  since?: string | null;
  lastActivity?: string | null;
  approval?: { id: string; summary: string } | null;
  question?: { text: string; options?: string[] | null } | null;
}

export interface Brief {
  text: string;
  at: string;
  by: { id: string; name: string };
}

export interface Overview {
  brief: Brief | null;
  counts: { working: number; needsYou: number; doneToday: number };
  items: OverviewItem[];
}

export type OversightLevel = "watch" | "suggest" | "act";

/** The agent overseeing the crew, if any. */
export interface Manager {
  agentId: string | null;
  level: OversightLevel | null;
}

export interface Suggestion {
  id: string;
  at: string;
  text: string;
  action: Record<string, unknown>;
  state: "open" | "done" | "dismissed";
  subject?: ActivityParty | null;
}

/** What an overseer's DM message mentions that can be acted on in place. */
export interface DeskExtras {
  approvals?: { sessionId: string; approvalId: string; summary: string }[];
  suggestions?: { id: string; text: string; state: Suggestion["state"] }[];
}
