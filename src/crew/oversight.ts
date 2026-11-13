import { parse, stringify } from "smol-toml";
import type { DeskHub } from "../hub/client";
import type { FullBudget, OversightLevel } from "../hub/types";

/** An agent's `[oversight]`: whether it oversees the crew and how. */
export interface Oversight {
  enabled: boolean;
  /** The sidebar group it oversees as that group's boss; null: everything
   *  ungrouped, as the main overseer. */
  group: string | null;
  level: OversightLevel;
  track: { crew: boolean; deskSessions: boolean; externalSessions: boolean; workspaces: boolean };
  /** Minutes of 0 mean it doesn't speak up for that. */
  wake: {
    waitingMinutes: number;
    quietMinutes: number;
    onFinish: boolean;
    onFailure: boolean;
    /** A session's message to it on Desk's line gets a turn of its own;
     *  off, sessions' questions go to you. */
    onMessage: boolean;
    /** How long your last keystroke or message in a session it runs keeps
     *  that session yours (`hold_minutes`). */
    holdMinutes: number;
  };
  /** Local times like "09:00"; "" is off. */
  summaries: { morning: string; evening: string };
  /** Check-ins in any hour; what happens past them waits for the next. */
  maxCheckinsPerHour: number;
  /** The ceiling over a day. */
  maxCheckinsPerDay: number;
  act: {
    nudge: boolean;
    resumeRestart: boolean;
    readOnlyApprovals: boolean;
    handOutWork: boolean;
    interrupt: boolean;
    /** Nudge agents and hand them tasks; their turns still can't post or
     *  send outside Desk, delete, or change memory without the person. */
    messageAgents: boolean;
    /** Nudge sessions started in another terminal, which may not ask before
     *  they act. */
    messageTerminalSessions: boolean;
    /** Answer what sessions ask it on Desk's line; anything that pushes,
     *  deletes or sends still comes to you, with its draft. */
    answerSessions: boolean;
    /** Continue a session in another engine (`hand_off`). */
    handOff: boolean;
    /** Change a running session's permission mode (default, accept edits
     *  or plan only). */
    setMode: boolean;
  };
  /** How it runs sessions for you (`[oversight.work]`). */
  work: Work;
  /** `[oversight.full]`: where, and on what budget, Act fully ships. */
  full: Full;
}

/** Act fully's repos, workflows and daily budget. */
export interface Full {
  /** Not limited to the repos, folders and workflows listed; the budget
   *  stays optional. */
  anywhere: boolean;
  /** owner/name (GitHub's), a repo's address, or a local folder. */
  repos: string[];
  /** Plain workflow file names it may run (`deploy.yml`). */
  workflows: string[];
  /** Dollars a day of real money (plans aren't counted); null until set. */
  budgetUsdPerDay: number | null;
  /** When you last cleared today's count of the budget (an ISO time): it
   *  counts from then until midnight. */
  budgetClearedAt?: string | null;
}

/** Which sessions it takes on: only those it starts and you hand it, or
 *  every one it can. */
export type TakeOn = "handed" | "all";

export interface Work {
  /** Real, visible sessions for the work; helpers only for read-only
   *  lookups. */
  preferSessions: boolean;
  /** How many of its sessions may be starting or working at once. */
  parallel: number;
  takeOn: TakeOn;
  /** The engine new sessions run on when nothing says another. */
  engine: string;
  /** Its turns for its sessions' turn ends, in any hour. */
  maxTurnsPerHour: number;
}

/** The most sessions it may run at once, as the hub allows. */
export const MAX_PARALLEL = 12;
/** The most turns an hour it may spend on its sessions, as the hub allows. */
export const MAX_WORK_TURNS_PER_HOUR = 600;
/** How long your typing keeps a session yours, by default and at most. */
export const HOLD_MINUTES = 2;
export const MAX_HOLD_MINUTES = 60;
/** Act fully's limits, as the hub takes them. */
export const MAX_FULL_REPOS = 50;
export const MAX_FULL_WORKFLOWS = 20;
export const MAX_FULL_BUDGET_USD = 10_000;

export const DEFAULT_OVERSIGHT: Oversight = {
  enabled: false,
  group: null,
  level: "watch",
  track: { crew: true, deskSessions: true, externalSessions: true, workspaces: false },
  wake: { waitingMinutes: 5, quietMinutes: 30, onFinish: true, onFailure: true, onMessage: true, holdMinutes: HOLD_MINUTES },
  summaries: { morning: "09:00", evening: "" },
  maxCheckinsPerHour: 6,
  maxCheckinsPerDay: 100,
  act: {
    nudge: true,
    resumeRestart: true,
    readOnlyApprovals: false,
    // At Act it starts the sessions its work needs, as the hub defaults it.
    handOutWork: true,
    interrupt: false,
    messageAgents: false,
    messageTerminalSessions: false,
    answerSessions: true,
    handOff: false,
    setMode: false,
  },
  work: { preferSessions: true, parallel: 4, takeOn: "handed", engine: "claude", maxTurnsPerHour: 60 },
  full: { anywhere: false, repos: [], workflows: [], budgetUsdPerDay: null, budgetClearedAt: null },
};

const LEVELS: readonly OversightLevel[] = ["watch", "suggest", "act", "full"];

type Doc = Record<string, unknown>;

const table = (v: unknown): Doc => (v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {});
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const count = (v: unknown, d: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : d);
/** A whole number from `lo` to `hi`, as the hub takes it; else `d`. */
const within = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : d;
/** An engine named in one word ("claude", "codex"), as the hub takes it. */
const ENGINE_WORD = /^[a-z0-9]+$/;
const time = (v: unknown, d: string): string => (typeof v === "string" && (v === "" || TIME.test(v)) ? v : d);

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whether Desk can read the file to change it (it never writes over one it
 *  can't read). */
export const readable = (source: string): boolean => {
  try {
    if (source.trim()) parse(source);
    return true;
  } catch {
    return false;
  }
};

/** What an agent's config says about overseeing, its defaults where it says
 *  nothing (or something Desk can't use). */
export const oversightOf = (source: string): Oversight => {
  let doc: Doc = {};
  try {
    doc = source.trim() ? (parse(source) as Doc) : {};
  } catch {
    return DEFAULT_OVERSIGHT;
  }
  const o = table(doc.oversight);
  const d = DEFAULT_OVERSIGHT;
  const track = table(o.track);
  const wake = table(o.wake);
  const summaries = table(o.summaries);
  const act = table(o.act);
  const work = table(o.work);
  const full = table(o.full);
  const strings = (v: unknown, ok: (s: string) => boolean): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(ok))] : [];
  return {
    enabled: bool(o.enabled, d.enabled),
    group: typeof o.group === "string" && o.group.trim() ? o.group : d.group,
    level: LEVELS.includes(o.level as OversightLevel) ? (o.level as OversightLevel) : d.level,
    track: {
      crew: bool(track.crew, d.track.crew),
      deskSessions: bool(track.desk_sessions, d.track.deskSessions),
      externalSessions: bool(track.external_sessions, d.track.externalSessions),
      workspaces: bool(track.workspaces, d.track.workspaces),
    },
    wake: {
      waitingMinutes: count(wake.waiting_minutes, d.wake.waitingMinutes),
      quietMinutes: count(wake.quiet_minutes, d.wake.quietMinutes),
      onFinish: bool(wake.on_finish, d.wake.onFinish),
      onFailure: bool(wake.on_failure, d.wake.onFailure),
      onMessage: bool(wake.on_message, d.wake.onMessage),
      holdMinutes: within(wake.hold_minutes, 1, MAX_HOLD_MINUTES, d.wake.holdMinutes),
    },
    summaries: { morning: time(summaries.morning, d.summaries.morning), evening: time(summaries.evening, d.summaries.evening) },
    maxCheckinsPerHour: count(o.max_checkins_per_hour, d.maxCheckinsPerHour) || d.maxCheckinsPerHour,
    maxCheckinsPerDay: count(o.max_checkins_per_day, d.maxCheckinsPerDay) || d.maxCheckinsPerDay,
    act: {
      nudge: bool(act.nudge, d.act.nudge),
      resumeRestart: bool(act.resume_restart, d.act.resumeRestart),
      readOnlyApprovals: bool(act.read_only_approvals, d.act.readOnlyApprovals),
      handOutWork: bool(act.hand_out_work, d.act.handOutWork),
      interrupt: bool(act.interrupt, d.act.interrupt),
      messageAgents: bool(act.message_agents, d.act.messageAgents),
      messageTerminalSessions: bool(act.message_terminal_sessions, d.act.messageTerminalSessions),
      answerSessions: bool(act.answer_sessions, d.act.answerSessions),
      handOff: bool(act.hand_off, d.act.handOff),
      setMode: bool(act.set_mode, d.act.setMode),
    },
    work: {
      preferSessions: bool(work.prefer_sessions, d.work.preferSessions),
      parallel: within(work.parallel, 1, MAX_PARALLEL, d.work.parallel),
      takeOn: work.take_on === "handed" || work.take_on === "all" ? work.take_on : d.work.takeOn,
      engine: typeof work.engine === "string" && ENGINE_WORD.test(work.engine.trim()) ? work.engine.trim() : d.work.engine,
      maxTurnsPerHour: within(work.max_turns_per_hour, 1, MAX_WORK_TURNS_PER_HOUR, d.work.maxTurnsPerHour),
    },
    full: {
      anywhere: bool(full.anywhere, d.full.anywhere),
      repos: strings(full.repos, (r) => r !== "" && r.length <= 500),
      workflows: strings(full.workflows, (w) => !("problem" in parseWorkflow(w))),
      budgetUsdPerDay:
        typeof full.budget_usd_per_day === "number" && full.budget_usd_per_day > 0 && full.budget_usd_per_day <= MAX_FULL_BUDGET_USD
          ? full.budget_usd_per_day
          : null,
      budgetClearedAt: clearedAt(full.budget_cleared_at),
    },
  };
};

/** The config with `o` as its `[oversight]`; anything else in the file, and
 *  any key of `[oversight]` Desk doesn't know, stays. No group leaves no
 *  `group` key: the hub keeps a group apart while any config names it. */
export const withOversight = (source: string, o: Oversight): string => {
  const doc = (source.trim() ? parse(source) : {}) as Doc;
  const { group: _group, ...was } = table(doc.oversight);
  doc.oversight = {
    ...was,
    enabled: o.enabled,
    ...(o.group ? { group: o.group } : {}),
    level: o.level,
    track: {
      ...table(was.track),
      crew: o.track.crew,
      desk_sessions: o.track.deskSessions,
      external_sessions: o.track.externalSessions,
      workspaces: o.track.workspaces,
    },
    wake: {
      ...table(was.wake),
      waiting_minutes: o.wake.waitingMinutes,
      quiet_minutes: o.wake.quietMinutes,
      on_finish: o.wake.onFinish,
      on_failure: o.wake.onFailure,
      on_message: o.wake.onMessage,
      hold_minutes: Math.min(MAX_HOLD_MINUTES, Math.max(1, Math.round(o.wake.holdMinutes))),
    },
    summaries: { ...table(was.summaries), morning: o.summaries.morning, evening: o.summaries.evening },
    max_checkins_per_hour: o.maxCheckinsPerHour,
    max_checkins_per_day: o.maxCheckinsPerDay,
    act: {
      ...table(was.act),
      nudge: o.act.nudge,
      resume_restart: o.act.resumeRestart,
      read_only_approvals: o.act.readOnlyApprovals,
      hand_out_work: o.act.handOutWork,
      interrupt: o.act.interrupt,
      message_agents: o.act.messageAgents,
      message_terminal_sessions: o.act.messageTerminalSessions,
      answer_sessions: o.act.answerSessions,
      hand_off: o.act.handOff,
      set_mode: o.act.setMode,
    },
    work: {
      ...table(was.work),
      prefer_sessions: o.work.preferSessions,
      parallel: Math.min(MAX_PARALLEL, Math.max(1, Math.round(o.work.parallel))),
      take_on: o.work.takeOn,
      engine: ENGINE_WORD.test(o.work.engine) ? o.work.engine : DEFAULT_OVERSIGHT.work.engine,
      max_turns_per_hour: Math.min(MAX_WORK_TURNS_PER_HOUR, Math.max(1, Math.round(o.work.maxTurnsPerHour))),
    },
  };
  // Act fully's table: written once anything of it is set, kept as it is
  // otherwise (a budget never set stays absent).
  const { budget_usd_per_day: _budget, budget_cleared_at: _cleared, ...wasFull } = table(was.full);
  const anyFull = o.full.anywhere || o.full.repos.length > 0 || o.full.workflows.length > 0 || o.full.budgetUsdPerDay !== null || "full" in was;
  if (anyFull) {
    (doc.oversight as Doc).full = {
      ...wasFull,
      anywhere: o.full.anywhere,
      repos: o.full.repos,
      workflows: o.full.workflows,
      ...(o.full.budgetUsdPerDay !== null ? { budget_usd_per_day: o.full.budgetUsdPerDay } : {}),
      ...(o.full.budgetClearedAt ? { budget_cleared_at: o.full.budgetClearedAt } : {}),
    };
  }
  return stringify(doc) + "\n";
};

/** A cleared time as the file holds it: an RFC 3339 string (smol-toml
 *  reads an unquoted one as a date). */
const clearedAt = (v: unknown): string | null => {
  const at = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
};

/** Dollars as Desk says them: $1,000.00. */
export const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Act fully's budget in a line, as the Floor heads a boss's section:
 *  real money only. */
export const fullBudgetText = (b: FullBudget): string => {
  if (b.spentUsd === null) return `Act fully: today’s real money not read yet, of ${usd(b.budgetUsd)}`;
  return b.spent
    ? `Act fully stopped: ${usd(b.spentUsd)} of ${usd(b.budgetUsd)} real money spent today`
    : `Act fully: ${usd(b.spentUsd)} of ${usd(b.budgetUsd)} real money today`;
};

export const MAX_MINUTES = 1440;
export const MAX_CHECKINS = 500;
export const MAX_CHECKINS_PER_HOUR = 60;

/** Minutes as typed: a whole number from 1 to a day, or why not. */
export const parseMinutes = (typed: string): { value: number } | { problem: string } => {
  const t = typed.trim();
  if (!/^\d+$/.test(t)) return { problem: "Use a whole number of minutes." };
  const n = Number(t);
  if (n < 1 || n > MAX_MINUTES) return { problem: `Use 1 to ${MAX_MINUTES} minutes (a day).` };
  return { value: n };
};

/** A time as typed ("9:00", "18:30"), as "09:00", or why not. */
export const parseTime = (typed: string): { value: string } | { problem: string } => {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(typed.trim());
  const h = m ? Number(m[1]) : NaN;
  const min = m ? Number(m[2]) : NaN;
  if (!m || h > 23 || min > 59) return { problem: "Use a time like 09:00 or 18:30." };
  return { value: `${String(h).padStart(2, "0")}:${m[2]}` };
};

/** Check-ins as typed: a whole number from 1 to `most` (a day's by
 *  default), or why not. */
export const parseCheckins = (typed: string, most: number = MAX_CHECKINS): { value: number } | { problem: string } => {
  const t = typed.trim();
  if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > most) return { problem: `Use a whole number from 1 to ${most}.` };
  return { value: Number(t) };
};

/** A count of sessions at once as typed: 1 to 12, or why not (the hub's
 *  words). */
export const parseParallel = (typed: string): { value: number } | { problem: string } => {
  const t = typed.trim();
  if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > MAX_PARALLEL)
    return { problem: `How many sessions it may run at once must be a whole number from 1 to ${MAX_PARALLEL}.` };
  return { value: Number(t) };
};

/** How long your typing keeps a session yours, as typed: 1 to 60 minutes,
 *  or why not (the hub's words). */
export const parseHold = (typed: string): { value: number } | { problem: string } => {
  const t = typed.trim();
  if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > MAX_HOLD_MINUTES)
    return { problem: `How long your typing in a session keeps it yours must be a whole number of minutes from 1 to ${MAX_HOLD_MINUTES}.` };
  return { value: Number(t) };
};

/** A daily budget as typed ("25", "7.50"): dollars above 0, up to the
 *  hub's most, or why not (the hub's words). */
export const parseBudget = (typed: string): { value: number } | { problem: string } => {
  const t = typed.trim().replace(/^\$/, "");
  const n = /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : NaN;
  if (!(n > 0) || n > MAX_FULL_BUDGET_USD)
    return { problem: `Its daily budget must be an amount in dollars above 0 and up to ${MAX_FULL_BUDGET_USD}.` };
  return { value: n };
};

/** A repo as typed: owner/name (GitHub's), a repo's address
 *  (`git@host:owner/name.git`, `https://host/owner/name`), or a local
 *  folder (`~/dev/acme-web`, `/Users/…`); or why not. */
export const parseRepo = (typed: string, have: string[] = []): { value: string } | { problem: string } => {
  const t = typed.trim();
  const ownerName = /^[\w.-]+\/[\w.-]+$/;
  const address = /^(?:[a-z][a-z0-9+.-]*:\/\/[^\s/]+\/|[\w.-]+@[\w.-]+:|[\w-]+(?:\.[\w-]+)+\/)[\w.-]+\/[\w./-]+$/i;
  const folder = /^(?:~\/|\/)\S/;
  if (!t || t.length > 500 || !(ownerName.test(t) || address.test(t) || folder.test(t)))
    return { problem: "Name a repo as owner/name, its address, or a folder like ~/dev/acme-web." };
  if (have.includes(t)) return { problem: "That repo is already named." };
  if (have.length >= MAX_FULL_REPOS) return { problem: `Up to ${MAX_FULL_REPOS} repos.` };
  return { value: t };
};

/** A workflow as typed: a plain file name like deploy.yml, as the hub
 *  takes it (no folder, not a number), or why not (the hub's words). */
export const parseWorkflow = (typed: string, have: string[] = []): { value: string } | { problem: string } => {
  const t = typed.trim();
  const stem = /^(.+)\.ya?ml$/.exec(t)?.[1];
  const ok = t.length <= 200 && /^[A-Za-z0-9._-]+$/.test(t) && stem !== undefined && !stem.startsWith(".") && !/^\d+$/.test(stem);
  if (!ok) return { problem: `The workflows it may run must be a list of up to ${MAX_FULL_WORKFLOWS} file names like deploy.yml.` };
  if (have.includes(t)) return { problem: "That workflow is already named." };
  if (have.length >= MAX_FULL_WORKFLOWS) return { problem: `Up to ${MAX_FULL_WORKFLOWS} workflows.` };
  return { value: t };
};

/** Nothing limits it but its budget, Stop and the activity log: Act fully,
 *  whatever its switches and lists say (the hub holds it to that). */
export const isUnbound = (o: Oversight): boolean => o.level === "full";

/** Writes `change` of the agent's oversight into its config as it is now
 *  (read fresh, so nothing else in it is lost); answers with the config as
 *  written. */
export async function setAgentOversight(hub: DeskHub, id: string, change: (o: Oversight) => Oversight): Promise<string> {
  const source = await hub.agentConfig(id);
  if (!readable(source)) throw new Error("Their settings file has a mistake in it, so Desk won’t change it.");
  const toml = withOversight(source, change(oversightOf(source)));
  await hub.saveAgentConfig(id, toml);
  return toml;
}
