import type { Layout } from "../groups/model";

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
  /** The name the person gave it (kept by the hub), shown in place of
   *  `name`; absent from hubs that don't keep names. */
  displayName?: string | null;
  /** The sidebar group it's in, as the hub has the layout. */
  group?: { id: string; name: string } | null;
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
  name: string;
  /** Where its shell is (followed as it moves): where it reopens. */
  cwd: string;
  /** The names (never the values) of what Desk added to its environment. */
  envKeys: string[];
  shell: string;
  /** `exited`: its shell ended; `lost`: a reboot ended it. */
  state: "running" | "exited" | "lost";
  /** Its shell is running now. */
  live: boolean;
  exitCode: number | null;
  /** The shell's process id, for seeing what runs in it (Codex); asked of
   *  the hub, and absent until it sends it. */
  pid?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewTerminal {
  /** Desk's own id for it, so a pane knows it before the shell starts. */
  id?: string;
  name?: string;
  /** An existing folder on the hub's machine. */
  cwd: string;
  /** Added to the shell's environment: Desk's Claude Code plugin folder
   *  (the hub adds it to the person's own). The hub adds the terminal's id,
   *  a token for its hooks and where they post. */
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
  | {
      type: "snapshot";
      sessions: Session[];
      restore: Session[];
      rooms: Room[];
      terminals?: TerminalInfo[];
      /** The sidebar's groups, from hubs that keep them. */
      layout?: Layout;
    }
  /** The sidebar's groups changed on the hub. */
  | { type: "layout"; layout: Layout }
  | { type: "terminal"; terminal: TerminalInfo }
  | { type: "terminalRemoved"; id: string }
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
