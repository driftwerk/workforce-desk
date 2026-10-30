import type { Attachment, DeliveryKind } from "../chat/types";
import type { Layout } from "../groups/model";

export type Engine = "claude" | "codex";

export type SessionState =
  | "starting"
  | "working"
  | "blocked"
  /** Its turn ended waiting on the person: a tool auto mode refused, or a
   *  reply that asks them something. */
  | "asking"
  | "done"
  | "idle"
  | "interrupted"
  | "stopped"
  | "closed";

export type Origin = "desk" | "external";

/** Sub-agents or background shells a turn started that still run after
 *  its main turn ended: until they finish, it isn't done. */
export interface Background {
  count: number;
  since: string;
}

export interface PendingApproval {
  id: string;
  tool: string;
  detail: string;
  since: string;
  /** False when the terminal is the one asking. */
  answerable: boolean;
}

/** A tool auto mode refused in the turn a session stopped on. */
export interface Denied {
  /** Its label: "Bash(security find-generic-password …)". */
  tool: string;
  detail: string;
  /** Why auto mode refused it: "[Credential Exploration]". */
  reason: string;
  /** Whether Desk can allow it for the session: a classifier's verdict,
   *  not a safety check only the person can pass in the terminal. */
  allowable: boolean;
}

/** Why a session's turn is waiting on the person. */
export interface Asked {
  /** What it needs: "Stopped: Bash was not allowed", or its question. */
  ask: string;
  /** Why Desk read it so: "asked you to choose between 2 options". */
  why: string;
  options: string[] | null;
  denied: Denied | null;
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
  /** Background work still running after its turn ended; absent from older hubs. */
  background?: Background | null;
  /** While it is asking: what, and why Desk read it so; absent from older hubs. */
  asked?: Asked | null;
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
  /** Added to the session's environment, as for a terminal: Desk's Claude
   *  Code plugin folder, joined by the hub to the person's own. */
  env?: Record<string, string>;
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
  /** The channel its agents' conversations are on, frozen when it was
   *  made; an older hub doesn't say (`desk:<slug>`). */
  channel?: string;
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
  /** Its files, each naming the hub and agent whose store holds it. */
  attachments?: Attachment[];
  /** The agent's session message it is: `<hub>/<agent>/<message id>`. */
  source?: string;
  /** Why it was delivered outside a turn. */
  delivery?: DeliveryKind;
  /** The routed approval an `approval` delivery asks you to decide, on
   *  the hub of its author. */
  requestId?: string;
  /** On a main-timeline message, how many replies its thread has, and
   *  when the last came; absent from a hub that doesn't count them. */
  replyCount?: number;
  lastReplyAt?: string | null;
  /** Who wrote its thread's replies, latest first (at most three). */
  replyAuthors?: string[];
  /** The message it answers: the ask an agent's answer is to, the form
   *  your answer fills in, the post a hand-off answers. */
  inReplyTo?: string | null;
  /** The thread message this main-timeline copy was posted from. */
  copyOf?: string | null;
  /** The tools the agent's turn ran on the way, in order. */
  steps?: Step[];
  /** Whether it is for you: what Desk wrote, an answer to you, a delivery
   *  to you. Absent from a hub that doesn't say. */
  forYou?: boolean;
  /** A form you have answered. */
  answered?: boolean;
  /** A thread message with a copy in the room's timeline. */
  postedToRoom?: boolean;
}

/** A room message search found, and the text around its matches, each
 *  match between U+E000 and U+E001. */
export interface SearchHit {
  roomId: string;
  message: RoomMessage;
  snippet: string;
}

/** One tool an agent's turn ran: what it was, whether it worked, how long. */
export interface Step {
  tool: string;
  ok: boolean;
  ms: number;
}

/** A room message to keep. */
export interface NewRoomMessage {
  author: string;
  content: string;
  threadId?: string | null;
  hop?: number;
  attachments?: Attachment[];
  source?: string;
  delivery?: DeliveryKind;
  requestId?: string;
  inReplyTo?: string;
  steps?: Step[];
  /** A thread reply of yours, also posted to the room's timeline. */
  alsoInRoom?: boolean;
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
  | { type: "state"; key: string; value: unknown }
  /** A place's read point moved, in this window or another. */
  | { type: "read"; place: string; point: ReadPoint };

// ── Unread: read points and what's after them ────────────────────────────

/** Read through `at`: the message, event or version seen last, when there is one. */
export interface ReadPoint {
  at: string;
  message: string | null;
}

/** How a write moves a point: never back, or exactly there (Mark unread). */
export type ReadMark = "advance" | "set";

export interface ReadPut {
  /** A place's string form (`room:<id>`, `thread:<room>/<thread>`, …). */
  place: string;
  point: ReadPoint;
  mark: ReadMark;
}

/** A read point the hub keeps. */
export interface ReadRow extends ReadPoint {
  place: string;
}

export type Urgency = "needs" | "forYou" | "new";

/** What's unread in a room's main timeline or a thread. */
export interface Unread {
  count: number;
  forYou: number;
  /** The earliest unread message, to jump to when it isn't loaded. */
  first: string | null;
  lastAt: string | null;
}

export interface ThreadUnread {
  parent: RoomMessage;
  unread: Unread;
}

export interface RoomSummary {
  roomId: string;
  main: Unread;
  threads: ThreadUnread[];
}

export interface SessionUnread {
  id: string;
  since: string;
  urgency: Urgency;
}

export interface Count {
  count: number;
  lastAt: string | null;
}

/** `GET /api/desk/unread`: what's unread of this computer's places. */
export interface UnreadSummary {
  /** When Desk began keeping read points: older content counts as read. */
  floor: string;
  rooms: RoomSummary[];
  sessions: SessionUnread[];
  activity: Count;
  /** The brief's time, while it's unread. */
  brief: string | null;
  /** The update's point, for Desk to compare with its updater. */
  update: ReadPoint | null;
}

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
  | "interrupted"
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
  /** Background work still running after its turn ended (the item is then
   *  working); absent from older hubs. */
  background?: Background | null;
}

export interface Brief {
  text: string;
  at: string;
  by: { id: string; name: string };
}

export interface Counts {
  working: number;
  needsYou: number;
  doneToday: number;
}

export interface Overview {
  brief: Brief | null;
  counts: Counts;
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

// ── The floor: open needs, work, today's lanes, plan usage ───────────────

/** Where a turn, and anything it asks, can be found. */
export type Place =
  | { kind: "dm" }
  | { kind: "room"; room: string; thread: string | null }
  | { kind: "call" }
  | { kind: "session" }
  | { kind: "slack"; team: string | null; channel: string; thread: string | null }
  | { kind: "elsewhere" };

/** What a need's Allow answers, passed back to the hub as it gave it. */
export type DecideRef =
  | { kind: "session"; sessionId: string; approvalId: string }
  | { kind: "prompt"; agentId: string; sessionId: string; requestId: string }
  | { kind: "routed"; requestId: string };

/** How a need can be answered in place: allowed or denied, only in the
 *  session's terminal, or by replying where it was asked. */
export type Answer = { kind: "decide"; at: DecideRef } | { kind: "terminal" } | { kind: "reply" };

/** An agent (its id) or a Desk session (its id) on a hub. */
export interface Who {
  kind: "agent" | "session";
  id: string;
  name: string;
  engine: Engine | null;
}

export type NeedKind = "approval" | "question";

/** Something still waiting on the person. */
export interface Need {
  id: string;
  kind: NeedKind;
  who: Who;
  ask: string;
  options: string[] | null;
  since: string;
  place: Place;
  answer: Answer;
}

export type Outcome = "finished" | "asked" | "failed" | "stopped" | "limit" | "interrupted";

/** A turn running now, or one that ended. */
export interface Work {
  who: Who;
  what: string;
  place: Place;
  since: string;
  heardAt: string;
  endedAt: string | null;
  outcome: Outcome | null;
  /** Its main turn ended but work it started still runs; absent from older hubs. */
  background?: Background | null;
  /** What its agent or session is for and doing, in plain words; absent from older hubs. */
  gist?: Gist | null;
}

/** What an agent or session is for (`purpose`) and what it is doing or did
 *  (`now`), for someone with no context; `at`, when either was last written. */
export interface Gist {
  purpose: string | null;
  now: string;
  at: string;
}

/** The floor in one paragraph, as the hub wrote it. */
export interface FloorSummary {
  text: string;
  at: string;
}

/** `background`: the main turn was idle while work it started ran. */
export type SpanKind = "working" | "waiting" | "background";

export interface Span {
  kind: SpanKind;
  from: string;
  /** Null: still going. */
  to: string | null;
}

/** One agent's or session's day. */
export interface Lane {
  who: Who;
  spans: Span[];
}

/** `GET /api/desk/floor`. */
export interface FloorView {
  asOf: string;
  /** Oldest first. */
  needs: Need[];
  working: Work[];
  /** The last 24 hours, latest first. */
  done: Work[];
  lanes: Lane[];
  counts: Counts;
  /** How many the hub left out of `done` and `lanes`. */
  more: { done: number; lanes: number };
  /** Absent from older hubs; null until one is written. */
  summary?: FloorSummary | null;
}

export type PlanKind = "claude" | "chatgpt";

/** Whose sign-in a reading is from: this computer's CLI, or a login in the hub's vault. */
export type PlanWhere = "mac" | "hub";

export interface PlanWindow {
  usedPercent: number;
  resetsAt: string | null;
  /** Its length: 300 for the 5-hour window, 10 080 for the weekly one. */
  minutes: number;
}

export interface PlanReading {
  kind: PlanKind;
  where: PlanWhere;
  /** The same for every reading of one account, wherever it was made. */
  account: string | null;
  plan: string | null;
  windows: PlanWindow[];
  observedAt: string;
}

/** `GET /api/desk/usage`. */
export interface UsageView {
  asOf: string;
  logins: { kind: PlanKind; where: PlanWhere; signedIn: boolean }[];
  readings: PlanReading[];
}
