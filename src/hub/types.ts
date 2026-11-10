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
  /** It can start asking its plan's faster tier ("Fast mode"); absent from
   *  older hubs. */
  fast?: boolean;
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
  /** Codex asks its plan's faster tier ("Fast mode"); absent from older hubs. */
  fast?: boolean;
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
  /** Codex asks its plan's faster tier ("Fast mode"). */
  fast?: boolean;
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
  /** The sidebar group it belongs to; absent when none, and from older
   *  hubs. One with a boss of its own takes only that group's agents. */
  group?: string | null;
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
  /** One of the person's settings changed (`memory.paused`, `memory.group.<id>`, `memory.session.<id>`). */
  | { type: "setting"; key: string }
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
  | { type: "accounts"; accounts: EngineAccount[]; problems?: SignInProblem[]; needs?: AccountNeed[]; autoSwitch?: boolean; ownPlanKey?: string | null }
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
  | { type: "boardRemoved"; id: string }
  /** A boss's plan was made or changed: proposed, approved, edited,
   *  paused, dropped or done. */
  | { type: "plan"; plan: BossPlan };

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
  /** Which Anthropic account it is, when known: the person said so, or its
   *  usage matched this computer's own Claude Code sign-in. */
  identity?: AccountIdentity | null;
  /** What its hub knows of its plan: passed to the person's other
   *  computers' hubs, which have the same account. */
  standing?: AccountStanding | null;
  createdAt: string;
}

export interface AccountIdentity {
  /** Its identity's key: a hash, never its organization or email. */
  key: string;
  email: string | null;
  linkedBy: "manual" | "usage";
  /** This computer's own Claude Code is signed in to it. */
  thisComputer: boolean;
}

/** What a hub knows of one account's plan, as it keeps it. */
export interface AccountStanding {
  windows: { usedPercent: number; resetsAt: string | null; minutes: number }[];
  readAt: string | null;
  hitAt: string | null;
  hitUntil: string | null;
  hitWindow: number | null;
}

/** One account's standing as another of the person's computers knew it. */
export interface StandingElsewhere {
  engine: Engine;
  name: string;
  identity?: string | null;
  standing: AccountStanding;
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
  | { kind: "signIn"; id: string; engine: Engine; account: AccountSide; problem: SignInProblem["problem"] }
  /** A session in a terminal of its own sits on a full plan: Desk can't
   *  move it. */
  | { kind: "inTerminal"; id: string; engine: Engine; session: string; name: string; account: AccountSide; resetsAt: string | null }
  /** Which of the person's accounts this computer's Claude Code is signed
   *  in to isn't known, and a switch depends on it. */
  | { kind: "whichSignIn"; id: string; engine: Engine; email: string | null };

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
  /** The key this computer's CLI sign-in's plan card has. */
  ownPlanKey?: string | null;
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

/** `work`: one row per piece of work, a session and every session it was
 *  handed on to, named as it goes on now. */
export type SpendBy = "session" | "project" | "day" | "engine" | "account" | "work";
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
  | { kind: "agent"; id: string }
  /** A boss's plan's own budget, set as it is approved. */
  | { kind: "plan"; id: string };

/** A budget's period: a plan's may be its whole run (`total`), which never
 *  resets. */
export type BudgetPeriod = SpendPeriod | "total";

export type BudgetUnit = "usd" | "tokens";
/** Over a budget: `pause` the turn after (agents' new turns; a total's new
 *  starts) until you say Continue, or only `warn`. */
export type OnExceed = "pause" | "warn";

export interface Budget {
  id: string;
  scope: BudgetScope;
  /** The sidebar group it is the budget of; null is ungrouped. */
  group: string | null;
  period: BudgetPeriod;
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
  /** A `total`'s `to` is far off (2200): it never resets. */
  period: BudgetPeriod;
  unit: BudgetUnit;
  used: number;
  of: number;
  status: BudgetStatus;
  onExceed: OnExceed;
  from: string;
  to: string;
  /** Counted over many sessions together (a plan's), not one's own alone. */
  shared?: boolean;
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
  /** The sidebar group it was in when it happened, as the hub stamped it
   *  (null: ungrouped); absent from hubs that don't stamp. */
  group?: string | null;
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

/** `full` is Act fully: Act, and shipping in the repos the person names
 *  (an older hub knows only the first three). */
export type OversightLevel = "watch" | "suggest" | "act" | "full";

/** The agent overseeing the crew, if any. */
export interface Manager {
  agentId: string | null;
  level: OversightLevel | null;
  /** Each sidebar group's boss; an older hub says none. */
  bosses?: GroupBoss[];
  /** Groups closed to everyone but the person: named for a boss that
   *  oversees nothing now. */
  sealed?: string[];
}

/** A sidebar group's boss: an agent of this computer's hub that oversees
 *  only that group. */
export interface GroupBoss {
  agentId: string;
  name: string;
  /** The group's id. */
  group: string;
  level: OversightLevel;
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
  /** The boss's plan a plan card shows, as of the revision it was posted
   *  for. */
  plan?: { id: string; revision: number };
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
  /** How long, in minutes, the person's last input keeps the wheel theirs
   *  (unpinned); an older hub doesn't say. */
  holdMinutes?: number;
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
  | { kind: "breaker"; subject: string }
  /** A boss's plan, or a change of scope to it, as of `revision`: allow is
   *  Approve and run; deny leaves it as it is. Only the person answers it. */
  | { kind: "plan"; plan: string; revision: number };

/** An answer to a need: Codex's requests take the last two as well. */
export type Choice = "allow" | "deny" | "allow_for_session" | "cancel";

/** How a need can be answered in place: allowed or denied, only in the
 *  session's terminal, or by replying where it was asked. */
export type Answer = { kind: "decide"; at: DecideRef } | { kind: "terminal" } | { kind: "reply" };

/** An agent (its id), a Desk session (its id) on a hub, or Desk itself
 *  (what its breaker holds new sessions for: `pool:…`). A boss, as a plan's
 *  need names it, is `manager`: the Floor reads it as the agent it is. */
export interface Who {
  kind: "agent" | "session" | "desk" | "manager";
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
  /** The sidebar group it is in now, as this computer's hub stamps its own
   *  items for the person who holds its Desk; absent when ungrouped, and
   *  from other hubs and older ones. */
  group?: string | null;
  /** That group's own boss (its agent id): absent for what is ungrouped, in
   *  a group with no boss of its own (the main boss's), or sealed. */
  boss?: string | null;
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
  /** As on `Need`. */
  group?: string | null;
  boss?: string | null;
  /** The session's work was handed to it from another: where from, and
   *  when. The session it left is folded under this tile. Absent for work
   *  that wasn't handed on, and from older hubs. */
  continued?: Continued | null;
}

/** Where the work a session's tile shows came from. */
export interface Continued {
  /** The session it was handed from. */
  from: string;
  /** That session's engine, when the hub still has it. */
  engine: Engine | null;
  at: string;
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
  /** The overseers, each with its scope: the main boss too. Only for the
   *  person who holds this hub's Desk; absent elsewhere. */
  bosses?: BossView[];
  /** Groups closed to everyone but the person: named for a boss that isn't
   *  overseeing them now. Their items carry their group and no boss. */
  sealed?: string[];
  /** The bosses' open plans, each in its own group. */
  plans?: PlanProgress[];
}

/** One overseer's part of Desk: everything in no bossed group (the main
 *  boss's), or one sidebar group. */
export type Scope = { kind: "ungrouped" } | { kind: "group"; group: string };

/** An overseer, as the Floor shows it at the head of its section. */
export interface BossView {
  scope: Scope;
  agent: string;
  name: string;
  /** `watch`, `suggest` or `act`. */
  level: string;
  state: "idle" | "working";
  /** What holds its turns, in plain words, while something does. */
  paused?: string | null;
  /** Its group's budget, the furthest along: none for the main boss, and
   *  for a group with no budget of its own. */
  spend?: Standing | null;
}

export type PlanState = "proposed" | "running" | "paused" | "done" | "dropped";

/** Where a plan's tickets stand. */
export interface PlanTally {
  done: number;
  doing: number;
  review: number;
  /** In To do with every need done, and no one on it yet. */
  ready: number;
  /** Held back by a need that was dropped. */
  blocked: number;
  /** Waiting on needs not done yet, or not handed out yet. */
  waiting: number;
  /** Every ticket but the dropped. */
  total: number;
  /** The tickets that start next as slots free, by key, in order. */
  next: string[];
}

/** A plan as the Floor shows it in its group's section. */
export interface PlanProgress {
  id: string;
  goal: string;
  /** Its group, as it was made; null is ungrouped. */
  group: string | null;
  boss: string;
  bossName: string;
  state: PlanState;
  /** Why it is paused, in the person's words, while it is. */
  pausedWhy?: string | null;
  progress: PlanTally;
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
  /** Which of the hub's logins made it (a key, never its credential):
   *  absent from hubs that don't say. */
  login?: string | null;
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

// ── A boss's plans: a goal broken into tickets, approved before it runs ──

/** The Floor's names for the same: a plan's state and its tickets' tally. */
export type BossPlanState = PlanState;

/** Why a plan that would run starts nothing. */
export type BossPlanPaused = "person" | "budget" | "boss_held" | "restoring" | "no_boss" | "start_failing";

export type BossPlanProgress = PlanTally;

/** A plan, with where its tickets stand. */
export interface BossPlan {
  id: string;
  board: string;
  /** The board's group when it was made; null is ungrouped. */
  group: string | null;
  /** The boss's agent id. */
  boss: string;
  bossName: string;
  goal: string;
  state: BossPlanState;
  /** Why it starts nothing; a newer hub may name reasons Desk doesn't know
   *  yet, said in `pausedWhy`. */
  paused: BossPlanPaused | (string & {}) | null;
  /** Why it is paused, in the hub's own words, when it says. */
  pausedWhy?: string | null;
  /** Its own limit of sessions at once, when lower than its boss's. */
  parallel: number | null;
  /** Its newest revision. */
  revision: number;
  /** The revision its runner follows; null before the person approves. */
  approvedRevision: number | null;
  createdAt: string;
  updatedAt: string;
  progress: BossPlanProgress;
  /** What it may spend: as approved, or as proposed before it is; none is
   *  no budget of its own. Absent from hubs before plan budgets. */
  budget?: PlanBudget | null;
  /** What holds its new starts while Desk's breaker does, in the Floor's
   *  words: Continue on the Floor. */
  held?: string | null;
}

/** What a plan may spend. */
export interface PlanBudget {
  amount: number;
  unit: BudgetUnit;
  period: BudgetPeriod;
  /** The share it warns at, between 0 and 1. */
  warnAt: number;
  onExceed: OnExceed;
}

/** A plan's ticket as its card shows it: the board's ticket, and what its
 *  session starts in. */
export interface BossPlanTicket extends Ticket {
  engine: Engine | null;
  folder: string | null;
  view: View | null;
  /** Its session is being started. */
  starting: boolean;
  /** What holds its session while Desk's breaker does: it is blocked on
   *  the person, and nothing starts in its place. */
  held?: string | null;
}

/** One ticket of a revision, as the plan has it. */
export interface PlannedTicket {
  id: string;
  title: string;
  body: string;
  engine: Engine;
  folder: string;
  view: View | null;
  /** The plan's tickets it needs done first. */
  needs: string[];
}

/** One revision of a plan, as kept. */
export interface BossPlanRevision {
  plan: string;
  revision: number;
  at: string;
  by: ActivityParty;
  /** A change within what was approved, or of its scope. */
  change: "minor" | "scope";
  summary: string;
  /** `parallel`: its own limit of sessions at once; none is its boss's. */
  snapshot: { goal: string; tickets: PlannedTicket[]; parallel?: number; budget?: PlanBudget | null };
}

/** A plan in full: its tickets in its order, its waves and revisions. */
export interface BossPlanDetail extends BossPlan {
  tickets: BossPlanTicket[];
  waves: string[][];
  revisions: BossPlanRevision[];
  /** Where its budget stands now, when it has one and it can be counted. */
  spend?: Standing | null;
}

/** A ticket as the person's edit writes it: by its id when the plan has
 *  it, what it needs by its place in the list (from 0). */
export interface DraftTicket {
  id?: string;
  title: string;
  body?: string;
  /** None: the plan's first ticket's engine. */
  engine?: Engine;
  folder: string;
  view?: View | null;
  needs: number[];
}

/** The person's edit, made from `revision`. */
export interface BossPlanEdit {
  revision: number;
  goal?: string;
  /** null takes the boss's limit again. */
  parallel?: number | null;
  /** Every ticket it is to have, in order. */
  tickets?: DraftTicket[];
  /** What it may spend; null takes its budget off. */
  budget?: PlanBudget | null;
}

/** What an edit came to. */
export interface BossPlanChanged {
  plan: BossPlanDetail;
  change: "minor" | "scope" | null;
  applied: boolean;
  summary: string;
}

/** What dropping a plan does with the sessions working on it. */
export type OnPlanDrop = "stop" | "leave";

/** A decision, fact or to-do Desk noted from a session, or the person wrote. */
export interface MemoryNote {
  id: string;
  kind: "decision" | "fact" | "todo";
  text: string;
  /** A to-do's `open`, `done` or `dropped`; anything else `held`. */
  state: "open" | "done" | "dropped" | "held";
  /** Since when it is so. */
  at: string;
  /** Desk's model wrote it, and it may be wrong. */
  notedByDesk: boolean;
  /** The person confirmed or wrote it. */
  confirmed: boolean;
  /** None of the exchanges it came from is kept any more. */
  sourceGone: boolean;
}

/** A note another replaced: what it said, and when. */
export interface ReplacedNote {
  id: string;
  kind: MemoryNote["kind"];
  text: string;
  replacedAt: string;
}

/** Why Desk isn't noting decisions from a session, for the panel to act on. */
export type NotingReason = "desk_off" | "no_model" | "paused" | "session_off" | "group_off" | "day_cap" | "failing";

export interface MemoryNotes {
  decisions: MemoryNote[];
  facts: MemoryNote[];
  todos: MemoryNote[];
  counts: {
    decisions: number;
    facts: number;
    todos: number;
    openTodos: number;
    /** Every note kept, replaced and dropped ones too: what forgetting deletes. */
    kept?: number;
  };
  /** `paused`: the day's calls are spent, until tomorrow. */
  noting: "on" | "paused" | "off";
  /** Why it isn't, or what else to know, in plain words. */
  why: string | null;
  /** Absent from hubs before the memory switches' routes. */
  reason?: NotingReason | null;
  /** Exchanges not yet read for notes. */
  unread: number;
  /** Whose model writes the notes (`anthropic`, `codex`, …). */
  provider: string | null;
  /** The hub may write them on another provider when that one can't. */
  fallbackProviders: boolean;
  /** Notes replaced lately, latest first; absent from older hubs. */
  replaced?: ReplacedNote[];
}

/** One prompt and what the session did for it, as Desk keeps it. */
export interface KeptExchange {
  seq: number;
  at: string;
  ended: string | null;
  asker: string;
  ask: string;
  answer: string;
  files: string[];
  commands: string[];
  errors: string[];
  compaction: boolean;
  /** Secrets hidden in it. */
  redacted: number;
}

/** What Desk remembers of one session. */
export interface SessionMemory {
  exchanges: KeptExchange[];
  counts: { exchanges: number; open: number; compactions: number; secretsHidden: number; pastCap: number };
  /** What it says now is being remembered. */
  remembering: boolean;
  /** Why not, in plain words. */
  why: string | null;
  notice: string | null;
  notes: MemoryNotes;
  /** Its own Remember switch; absent from older hubs. */
  memoryOn?: boolean;
  /** Its engine keeps no record Desk can read. */
  noRecord?: boolean;
  /** When Desk last kept something it said. */
  lastRead?: string | null;
  /** Desk no longer has the session: there is no switch to turn. */
  cleared?: boolean;
  /** The pause and its group's switches, as its hub has them. */
  switches?: { paused: boolean; group: (GroupMemory & { id: string; name: string }) | null };
}

/** What the person does to a note. */
export type NoteChange = { action: "confirm" } | { action: "correct"; text: string } | { action: "drop" };

/** How Desk Memory's search index stands. */
export interface MemoryIndexStatus {
  /** This computer has a search index at all. */
  installed: boolean;
  /** Exchanges not yet in it. */
  backlog: number;
  purges: number;
  /** Why it isn't answering, while it isn't. */
  failing: string | null;
  caughtUp: string | null;
  reconciled: string | null;
  /** Exchanges it kept refusing, found by keyword. */
  setAside: number;
  /** Forgotten conversations it kept refusing to delete, until a rebuild. */
  purgesSetAside: number;
  diskMb: number | null;
  maxDiskMb: number;
}

/** A group's memory switches. */
export interface GroupMemory {
  harvest: boolean;
  derive: boolean;
  handoffAsk: boolean;
  /** The person answered whether Desk's model may read its sessions. */
  deriveDecided: boolean;
}

/** What session memory holds of one group's sessions (`group` null: ungrouped). */
export interface MemoryTotals {
  group: string | null;
  sessions: number;
  exchanges: number;
  secretsHidden: number;
  notes: number;
}

/** The person's memory settings, the install's limits, and what is kept. */
export interface MemorySettings {
  paused: boolean;
  groups: (GroupMemory & { id: string; name: string })[];
  limits: {
    enabled: boolean;
    derive: boolean;
    backfillDays: number;
    retainDays: number;
    maxDiskMb: number;
    indexPerMinute: number;
    deriveCallsPerDay: number;
    deriveCallsToday: number;
    /** Whose model writes the notes (`anthropic`, …); none without one. */
    provider?: string | null;
    /** The hub may write them on another provider when that one can't. */
    fallbackProviders?: boolean;
  };
  totals: MemoryTotals[];
  /** What the person should know of the change just made. */
  notice?: string;
}

/** An exchange or a note a search of Desk's memory found. */
export interface MemoryHit {
  session: string;
  group: string | null;
  project: string;
  at: string;
  asker: string;
  ask: string;
  answer: string;
  compaction: boolean;
  kind: "exchange" | "compaction" | "decision" | "fact" | "todo";
  notedByDesk: boolean;
  confirmed: boolean;
  superseded: boolean;
  name: string | null;
  engine: Engine | null;
  groupName: string | null;
}

export interface MemorySearch {
  hits: MemoryHit[];
  /** Only keywords were matched: the search index isn't ready. */
  keywordOnly: boolean;
  notice: string | null;
}

// ── Continue in another engine (handoff) ─────────────────────────────────

/** Where the session that continues the work runs. */
export type HandoffPlace = "same_folder" | "new_worktree";

/** What becomes of the session the work leaves: stopped now, stopped once
 *  its turn ends, or left running. */
export type HandoffSource = "stop" | "after_turn" | "keep";

/** What a handoff is asked as: the body of `POST …/handoff`, whose keys the
 *  hub takes exactly (any other is refused). `account` absent is the
 *  engine's default; null, the CLI's own sign-in. */
export interface HandoffAsk {
  engine?: Engine;
  account?: string | null;
  place?: HandoffPlace;
  source?: HandoffSource;
  back?: boolean;
  goalOnly?: boolean;
  egressConfirmed?: boolean;
}

/** What a brief holds, and of how many. */
export interface Included {
  goal: boolean;
  decisions: number;
  ofDecisions: number;
  todos: number;
  ofTodos: number;
  facts: number;
  ofFacts: number;
  exchanges: number;
  ofExchanges: number;
  files: number;
  ofFiles: number;
  /** Exchanges left out because they read as instructions to a model. */
  flaggedLeftOut: number;
  /** Exchanges left out because they were kept in another group. */
  elsewhereLeftOut: number;
  /** Exchanges given cut short to fit. */
  cut: number;
  tokens: number;
}

/** One step of a work's lineage. */
export interface Hop {
  session: string;
  name: string;
  engine: Engine;
  at: string | null;
}

/** A session's place in its work: where it came from and went. */
export interface LineageView {
  /** The work's first session. */
  work: string;
  from: Hop | null;
  handedTo: Hop | null;
  /** Every session of the work, the first first. */
  sessions: string[];
}

/** What a handoff would give, before the person confirms it. */
export interface HandoffPreview {
  engine: Engine;
  content: "brief" | "goal_only";
  /** The brief as the target would read it. */
  brief: string;
  included: Included;
  /** "Codex gets: …", in the person's words. */
  gets: string;
  leavesOut: string | null;
  tokens: number;
  budget: number;
  vendor: string | null;
  /** "The brief goes to OpenAI, through Codex." */
  egress: string;
  /** The source's group asks the person to confirm each handoff. */
  ask: boolean;
  /** The target can search the rest of the work. */
  search: boolean;
  /** Said when it can't: "Only the brief goes across." */
  onlyBrief: string | null;
  /** Desk's notes of the source weren't ready in time. */
  notesPending: boolean;
  /** A hand back is offered: resume the session the work came from. */
  back: Hop | null;
  lineage: LineageView;
}

/** A handoff made. */
export interface HandedOff {
  /** The session the work continues in. */
  session: Session;
  included: Included;
  /** "Handed over: …", as the target's card says it. */
  said: string;
  egress: string;
  /** What didn't follow the work, in plain words. */
  notes: string[];
}
