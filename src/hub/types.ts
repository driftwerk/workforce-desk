import type { Attachment, DeliveryKind } from "../chat/types";
import type { Layout } from "../groups/model";

export type Engine = "claude" | "codex" | "gemini" | "copilot" | "opencode" | "cursor" | "devin" | "custom";

/** Where a session runs: a terminal, or Desk's own view of it. */
export type View = "terminal" | "desk";

/** What an engine can do in a view, as the hub drives it today. */
export interface Caps {
  state: "hooks" | "server" | "none";
  approvals: "desk" | "terminal" | "none";
  resume: "byId" | "none";
  interrupt: "keys" | "none";
  /** Whose plan windows its sessions report. */
  plan: "claude" | "codex" | null;
  /** It can start with its own reviewer answering its approvals
   *  ("Approve for me"); absent from older hubs. */
  approveForMe?: boolean;
  /** Whether its sessions can each run on one of the person's accounts
   *  (`token`: a `setup-token` sign-in per account); absent from older hubs. */
  accounts?: "token" | "none";
  /** How Desk's line reaches its sessions: Desk's plugin submits, or it is
   *  typed in at the prompt; `none`, it has no line. Absent from older hubs. */
  line?: "submit" | "paste" | "none";
  /** How the person's Send now reaches a working turn; `none`: queue only.
   *  Absent from older hubs. */
  steer?: "paste" | "turnSteer" | "none";
  /** What the person reads beside it. */
  notes: string[];
}

/** Who an engine on the hub's computer is signed in as. `plan` is the
 *  plan's name as the engine says it ("ultra", "pro"): shown as it is. */
export type SignIn =
  | { state: "in"; via: "plan" | "key" | "vendor"; who: string | null; plan: string | null }
  | { state: "out" }
  | { state: "unknown" };

/** One engine as Settings → Engines and the new session dialog show it. */
export interface EngineInfo {
  engine: Engine;
  title: string;
  program: string | null;
  /** Whether its program runs; null until the hub has looked. */
  installed: boolean | null;
  version: string | null;
  signIn: SignIn;
  /** The views the hub starts it in, the default first: none while it can't. */
  views: View[];
  caps: Partial<Record<View, Caps>>;
}

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
  /** What Codex offers to answer it with; absent: allow or deny. */
  choices?: Choice[];
  /** What Codex said of it: where it runs, and why. */
  why?: string;
  /** The answers a question it asks in its terminal offers (Claude Code's
   *  AskUserQuestion, Codex's request for input); absent from older hubs. */
  options?: string[];
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
  /** The machine it runs on, stamped by Desk as its engine is read (see
   *  hub/machines.ts); none for this computer's. */
  machine?: string;
  engine: Engine;
  /** Where it runs and what Desk can do with it; absent from older hubs. */
  view?: View;
  caps?: Caps;
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
  /** Codex's own reviewer answers its approvals; absent from older hubs. */
  approveForMe?: boolean;
  /** The person's account it runs on; null: the CLI's own sign-in. */
  account?: AccountRef | null;
  /** The account it moves to once its turn ends, while a switch waits. */
  switchingTo?: AccountRef | null;
  /** The terminal ground, light or dark, its CLI took its colours from at
   *  its start, for a CLI that reads them only then (Codex): a change of
   *  ground shows once it restarts. Absent for one that follows the
   *  terminal as it runs (Claude Code), one started before Desk said its
   *  colours or taken back after the hub restarted, and from older hubs. */
  fixedGround?: "light" | "dark" | null;
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

/** A session removed from Desk: Desk no longer tracks it, and never takes
 *  it back from another terminal until it's tracked again. */
export interface HiddenSession {
  engine: Engine;
  cliSessionId: string;
  /** What Desk called it, and where it ran, when it was removed. */
  name: string;
  cwd: string;
  hiddenAt: string;
}

/** What a removal did: sessions removed, transcript files deleted. */
export interface Removed {
  removed: number;
  transcripts: number;
}

export interface NewSession {
  engine: Engine;
  view?: View;
  name: string;
  cwd: string;
  goal?: string;
  worktree?: string;
  prompt?: string;
  approvals?: "desk" | "terminal";
  /** Codex's own reviewer answers its approvals ("Approve for me"). */
  approveForMe?: boolean;
  /** The person's account it runs on: absent, the engine's default;
   *  null, the CLI's own sign-in on the hub's computer. */
  account?: string | null;
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
  | { type: "read"; place: string; point: ReadPoint }
  /** A session's spend changed: what its engine recorded was read. */
  | { type: "spend"; session: string }
  /** The person's engine accounts changed: all of them as they now are. */
  | { type: "accounts"; accounts: EngineAccount[]; problems?: SignInProblem[]; needs?: AccountNeed[]; autoSwitch?: boolean }
  /** Signing in to a new account moved on. */
  | { type: "accountSignIn"; signIn: AccountSignIn }
  /** The budgets changed: all of them as they now are. */
  | { type: "budgets"; budgets: Budget[] }
  /** Where one of Desk's breakers stands changed. */
  | { type: "breaker"; breaker: BreakerView }
  /** A message on a session's line was sent or moved on; `removed` once
   *  you took it back. */
  | { type: "line"; message: LineMessage; removed?: boolean }
  /** A boss took a session on or let it go (`releasedAt` set), or its
   *  wheel changed hands. */
  | { type: "charge"; charge: ChargeView }
  /** A board's ticket was made or changed. */
  | { type: "ticket"; ticket: Ticket }
  | { type: "ticketRemoved"; id: string }
  /** A board was made or changed. */
  | { type: "board"; board: Board }
  | { type: "boardRemoved"; id: string };

// ── Engine accounts: several subscription logins per engine ──────────────

/** A session's account, as it names it. */
export interface AccountRef {
  id: string;
  name: string;
}

/** One of the person's accounts. Its sign-in stays on the hub's computer:
 *  Desk is never sent it. */
export interface EngineAccount {
  id: string;
  engine: Engine;
  name: string;
  isDefault: boolean;
  /** Its sign-in is still where the hub keeps it. */
  signedIn: boolean;
  /** The sessions running on it now. */
  sessions: string[];
  /** The key its plan readings have (a plan card's `claude:<key>`). */
  planKey?: string | null;
  createdAt: string;
}

/** One side of a switch: an account, or (`id` null) the CLI's own sign-in. */
export interface AccountSide {
  id: string | null;
  name: string;
}

/** A Floor need about the person's accounts. */
export type AccountNeed =
  | { kind: "limit"; id: string; engine: Engine; from: AccountSide; to: AccountSide; sessions: string[]; resetsAt: string | null }
  | { kind: "allFull"; id: string; engine: Engine; resets: [AccountSide, string | null][] }
  | { kind: "reset"; id: string; engine: Engine; account: AccountSide; from: AccountSide; sessions: string[] }
  /** An account's sign-in can't be used: nothing switches to it. */
  | { kind: "signIn"; id: string; engine: Engine; account: AccountSide; problem: SignInProblem["problem"] };

/** What moving every session off an account did. */
export interface SwitchedAll {
  now: string[];
  afterTurn: string[];
  nextStart: string[];
  inTerminals: string[];
}

/** What is wrong with an account's sign-in on the hub's computer: gone,
 *  unreadable just now, or left behind when the account was removed. */
export interface SignInProblem {
  account: string;
  name: string;
  problem: "gone" | "unreadable" | "notRemoved";
}

/** Where signing in through the engine's own command is. */
export type AccountSignInState =
  | { state: "starting" }
  | { state: "open"; url: string | null }
  | { state: "code"; url: string | null }
  | { state: "checking" }
  | { state: "done"; account: string }
  | { state: "failed"; why: string };

export type AccountSignIn = {
  id: string;
  engine: Engine;
  name: string;
  /** For a sign-in made from another computer: the page that comes back to
   *  the hub's computer by itself (`http://localhost:{port}/callback`
   *  there) can be asked for. Only the native side asks for it. */
  directReady?: boolean;
} & AccountSignInState;

/** An engine's own sign-in where it has no browser (Codex's device
 *  sign-in): the page to open and the code to type there. */
export type EngineSignIn = { id: string; engine: Engine } & (
  | { state: "starting" }
  | { state: "device"; url: string; code: string }
  | { state: "done" }
  | { state: "failed"; why: string }
);

export interface AccountsInfo {
  accounts: EngineAccount[];
  /** Where the sign-ins are kept ("the keychain"); null: this Desk keeps none. */
  store: string | null;
  signIns: AccountSignIn[];
  needs?: AccountNeed[];
  autoSwitch?: boolean;
  problems?: SignInProblem[];
}

/** What adding an account did. */
export type AccountAdded = { kind: "account"; account: EngineAccount } | { kind: "signIn"; signIn: AccountSignIn };

// ── Spend: what sessions cost, from the hub's ledger ─────────────────────

/** A call's tokens; `reasoning` is already inside `output`. */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export type Billing = "plan" | "key" | "vendor" | "unknown";

export interface SpendTotals {
  tokens: Tokens;
  /** At API list prices from the hub's table: what a key pays, and what a
   *  plan's calls are worth ("API-equivalent"). */
  usd: number;
  calls: number;
  unpricedCalls: number;
  /** Models with no price in the hub's table. */
  unpricedModels: string[];
  billing: Billing[];
}

export interface SpendRow {
  key: string;
  label: string;
  session: string | null;
  engine: Engine | null;
  folder: string | null;
  totals: SpendTotals;
}

export type SpendBy = "session" | "project" | "day" | "engine" | "account";
export type SpendPeriod = "five_hours" | "day" | "week" | "month";

export interface SpendView {
  from: string;
  to: string;
  by: SpendBy;
  total: SpendTotals;
  rows: SpendRow[];
  /** Rows past the limit, left out. */
  more: number;
}

// ── Budgets and Desk's breaker ───────────────────────────────────────────

/** What a budget applies to: everything together (`desk`), the default for
 *  each session or agent without its own, or one session's or agent's own. */
export type BudgetScope =
  | { kind: "desk" }
  | { kind: "each_session" }
  | { kind: "each_agent" }
  | { kind: "session"; id: string }
  | { kind: "agent"; id: string };

export type BudgetUnit = "usd" | "tokens";
/** Over a budget: `pause` the turn after (agents' new turns; a total's new
 *  starts) until you say Continue, or only `warn`. */
export type OnExceed = "pause" | "warn";

export interface Budget {
  id: string;
  scope: BudgetScope;
  /** The sidebar group it is the budget of; null is ungrouped. */
  group: string | null;
  period: SpendPeriod;
  unit: BudgetUnit;
  amount: number;
  /** The share it warns at, between 0 and 1. */
  warnAt: number;
  onExceed: OnExceed;
  updatedAt: string;
}

export type BudgetStatus = "under" | "warn" | "over";

/** Where what a budget counts stands now. */
export interface Standing {
  budget: string;
  period: SpendPeriod;
  unit: BudgetUnit;
  used: number;
  of: number;
  status: BudgetStatus;
  onExceed: OnExceed;
  from: string;
  to: string;
}

export interface BudgetView extends Budget {
  standing: Standing | null;
}

export type BreakerReason = { kind: "loop" } | { kind: "errors" } | { kind: "budget"; budget: string };

export type BreakerLevel =
  | { level: "clear" }
  | { level: "steered"; reason: BreakerReason; at: string }
  | { level: "held"; reason: BreakerReason; since: string; until: string; kept: boolean };

/** One of Desk's breakers: what it holds, and what the Floor asks of it. */
export interface BreakerView {
  /** `session:<id>`, `agent:<id>`, `pool:desk`, `pool:group:<id>`. */
  subject: string;
  name: string;
  level: BreakerLevel;
  ask: string | null;
  why: string | null;
}

export interface BreakerRules {
  /** Watch sessions for loops and repeated failures. */
  loops: boolean;
}

export interface BudgetsView {
  budgets: BudgetView[];
  breakers: BreakerView[];
  rules: BreakerRules;
}

export interface NewBudget {
  scope: BudgetScope;
  group: string | null;
  period: SpendPeriod;
  unit: BudgetUnit;
  amount: number;
  warnAt?: number;
  onExceed?: OnExceed;
}

/** One kept call, as the Ledger lists it. */
export interface LedgerRow {
  session: string;
  key: string;
  at: string;
  engine: Engine;
  model: string | null;
  tokens: Tokens;
  usd: number | null;
  priced: "priced" | "reported" | "none";
  billing: Billing;
  account: string | null;
  /** The board's ticket the session worked on when it made the call. */
  ticket?: string | null;
}

export interface LedgerPage {
  rows: LedgerRow[];
  /** The next page's start, when there is one. */
  next: string | null;
}

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

export type Decision = "allow" | "deny" | "terminal" | "allow_for_session" | "cancel";

// ── The crew overview: activity, the overview, the manager ────────────────

/** Who or what an activity event is by or about. */
export interface ActivityParty {
  /** `desk`: Desk itself, its breaker. */
  kind: "agent" | "session" | "manager" | "you" | "desk";
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
  | "assigned"
  /** An agent on another hub answered in one of your rooms. */
  | "replied"
  /** A delivery reached one of your rooms. */
  | "delivered"
  /** Desk's breaker told a session in its turn to stop or wrap up. */
  | "steered"
  /** Desk's breaker paused a session or agent, or held new sessions. */
  | "paused"
  /** You let what the breaker paused go on. */
  | "continued"
  /** A budget was set, changed or removed. */
  | "budgeted"
  /** A question on a session's line. */
  | "asked"
  /** A message on a session's line. */
  | "told"
  /** A boss took a session on, or the person handed it one. */
  | "taken_on"
  /** A boss let a session go, or the person took it back. */
  | "released"
  /** The person took the wheel of a session a boss runs. */
  | "driving"
  /** The wheel went back to the boss. */
  | "handed_back"
  /** A board's ticket was made, moved, given to someone, changed,
   *  commented on or deleted. */
  | "ticket_created"
  | "ticket_moved"
  | "ticket_assigned"
  | "ticket_edited"
  | "ticket_commented"
  | "ticket_deleted";

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
  /** Where in Desk it happened: a room, its thread. */
  place?: Place | null;
  /** The room message it's about. */
  message?: string | null;
  /** The board's ticket it's about: the ticket's history. */
  ticket?: string | null;
  /** What the hub kept beside the text: a comment's own words. */
  detail?: { comment?: string } | null;
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
  /** Questions sessions asked on their line that the overseer gave you. */
  questions?: MentionedQuestion[];
}

/** A session's question on its line, as the overseer's DM shows it. */
export interface MentionedQuestion {
  messageId: string;
  sessionId: string;
  session: string;
  ask: string;
  why: string;
  options?: string[];
  draft?: string | null;
}

// ── Desk's line: sessions, the overseer and you, to each other ──────────

export type LineKind = "ask" | "tell" | "answer";
export type LineDelivery =
  | "queued"
  | "handed"
  | "delivered"
  | "held"
  | "refused"
  /** Never delivered: its sender stopped running the session before it
   *  went in, and the person runs it now. */
  | "withdrawn"
  /** Shown in the thread only, never typed into the session. */
  | "noted";
/** "lapsed": its session stopped waiting and went ahead without an answer;
 *  "dismissed": you set it aside unanswered. */
export type LineAsked = "open" | "escalated" | "answered" | "withdrawn" | "lapsed" | "dismissed";
/** Why a queued message hasn't gone in yet. */
export type LineWait =
  | "stopped"
  | "working"
  | "typing"
  | "paused"
  | "asking"
  /** The person has the wheel of a session a boss runs: the boss's
   *  messages wait until it is handed back. */
  | "person_driving";

/** One message on a session's line. */
/** An ask's headline, and its details when it has any. */
export interface LineQuestion {
  headline: string;
  details?: string | null;
}

export interface LineMessage {
  id: string;
  at: string;
  from: ActivityParty;
  to: ActivityParty;
  kind: LineKind;
  text: string;
  inReplyTo: string | null;
  hop: number;
  delivery: LineDelivery;
  asked: LineAsked | null;
  /** Why the overseer gave it to you, what it offered, and its draft. */
  escalation: { why: string; options: string[]; draft: string | null } | null;
  /** An ask's: what the session said it goes ahead with if no answer comes
   *  in time. Absent when it didn't say (and from older hubs). */
  chose?: string | null;
  /** An ask's short work-item label ("W7 · PR 2"), as its session said it. */
  about?: string | null;
  /** An ask's one line on why it asks. */
  why?: string | null;
  /** An ask's details, as its session wrote them (markdown). */
  details?: string | null;
  /** An ask as Desk shows it: its one-line headline, and the rest. A
   *  question asked in one block of text (before asks had parts) is split
   *  by the hub, so nothing of it is lost. Absent from older hubs. */
  question?: LineQuestion | null;
  deliveredAt: string | null;
  updatedAt: string;
  waiting?: LineWait;
}

// ── Charges: which boss runs which session, and who drives it ─────────

/** Who drives a session a boss runs: the boss; the person, until they go
 *  quiet for ten minutes with it idle; or the person until they hand it
 *  back. */
export type Wheel = "boss" | "person" | "person_pinned";

/** How the boss came to run it: it started it, the person handed it over,
 *  or it takes on every session. */
export type ChargeHow = "started" | "handed" | "taken";

/** One session a boss runs, as the hub shows it. */
export interface ChargeView {
  session: string;
  /** The boss's sidebar group; null is the main boss. */
  group: string | null;
  /** The boss's agent id. */
  boss: string;
  bossName: string;
  how: ChargeHow;
  wheel: Wheel;
  wheelSince: string | null;
  since: string;
  /** Set once it was let go: it no longer runs it. */
  releasedAt: string | null;
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
  | { kind: "routed"; requestId: string }
  /** A Codex session's request, with the answers Codex offers for it. */
  | { kind: "codex"; sessionId: string; approvalId: string; choices: Choice[] }
  /** What Desk's breaker holds (`session:<id>`, `agent:<id>`, `pool:desk`,
   *  `pool:group:<id>`): allow is Continue, deny is Keep paused. */
  | { kind: "breaker"; subject: string };

/** An answer to a need: Codex's requests take the last two as well. */
export type Choice = "allow" | "deny" | "allow_for_session" | "cancel";

/** How a need can be answered in place: allowed or denied, only in the
 *  session's terminal, or by replying where it was asked. */
export type Answer = { kind: "decide"; at: DecideRef } | { kind: "terminal" } | { kind: "reply" };

/** An agent (its id), a Desk session (its id) on a hub, or Desk itself
 *  (what its breaker holds new sessions for: `pool:…`). */
export interface Who {
  kind: "agent" | "session" | "desk";
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
  /** What the answers do, when the ask needs it said. */
  why?: string | null;
  options: string[] | null;
  /** A session's question: what it said it goes ahead with if no answer
   *  comes in time. */
  chose?: string | null;
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
  /** Questions to you their sessions went ahead without, until answered or
   *  dismissed. Absent when none (and from older hubs). */
  wentAhead?: WentAhead[];
}

/** A question to you its session went ahead without. */
export interface WentAhead {
  /** `line:<message id>`. */
  id: string;
  who: Who;
  ask: string;
  chose?: string | null;
  askedAt: string;
  wentAheadAt: string;
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

// ── The board: the person's tickets, worked on by sessions and agents ────

export type TicketState = "backlog" | "todo" | "doing" | "review" | "done" | "dropped";

/** A board of tickets; `prefix` starts its keys (`ACM` for `ACM-12`). */
export interface Board {
  id: string;
  name: string;
  /** Its sidebar group; null is ungrouped. */
  group: string | null;
  prefix: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a ticket points at. */
export type TicketLink =
  | { kind: "session"; session: string }
  | { kind: "room"; room: string; thread?: string }
  | { kind: "message"; message: string }
  | { kind: "pr"; number: number; url: string };

/** A ticket as the hub shows it, with what the board computes of it. */
export interface Ticket {
  id: string;
  board: string;
  number: number;
  title: string;
  body: string;
  state: TicketState;
  rank: number;
  /** Who works on it: a session, an agent, or you. */
  assignee: ActivityParty | null;
  /** The tickets it needs done first. */
  needs: string[];
  links: TicketLink[];
  createdBy: ActivityParty;
  pinned: boolean;
  /** Hidden from the board until then, unless it changes. */
  snoozedUntil: string | null;
  /** When it came into its state. */
  stateAt: string;
  createdAt: string;
  updatedAt: string;
  /** `ACM-12`; null while a synced ticket waits for its remote key. */
  key: string | null;
  /** To do with every need done: it may be handed out. */
  ready: boolean;
  /** Its needs not yet done. */
  blockers: string[];
  /** Done for 3 days, or Dropped: on the settled shelf. */
  settled: boolean;
  snoozed: boolean;
}

export interface NewTicket {
  board: string;
  title: string;
  body?: string;
  state?: TicketState;
  needs?: string[];
}

export interface TicketPatch {
  title?: string;
  body?: string;
  pinned?: boolean;
  /** null wakes it. */
  snoozedUntil?: string | null;
}

/** A drop in a column: `before` is the card above where it lands, `after`
 *  the one below; neither puts it at the end. */
export interface TicketMove {
  state: TicketState;
  before?: string;
  after?: string;
}

/** Whom a ticket goes to; null takes it off whoever has it. */
export type AssignTo = { session: string } | { agent: string } | { newSession: { path: string; engine: Engine } } | null;
