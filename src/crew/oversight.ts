import { parse, stringify } from "smol-toml";
import type { DeskHub } from "../hub/client";
import type { OversightLevel } from "../hub/types";

/** An agent's `[oversight]`: whether it oversees the crew and how. */
export interface Oversight {
  enabled: boolean;
  level: OversightLevel;
  track: { crew: boolean; deskSessions: boolean; externalSessions: boolean; workspaces: boolean };
  /** Minutes of 0 mean it doesn't speak up for that. */
  wake: { waitingMinutes: number; quietMinutes: number; onFinish: boolean; onFailure: boolean };
  /** Local times like "09:00"; "" is off. */
  summaries: { morning: string; evening: string };
  /** Check-ins in any hour; what happens past them waits for the next. */
  maxCheckinsPerHour: number;
  /** The ceiling over a day. */
  maxCheckinsPerDay: number;
  act: { nudge: boolean; resumeRestart: boolean; readOnlyApprovals: boolean; handOutWork: boolean };
}

export const DEFAULT_OVERSIGHT: Oversight = {
  enabled: false,
  level: "watch",
  track: { crew: true, deskSessions: true, externalSessions: true, workspaces: false },
  wake: { waitingMinutes: 5, quietMinutes: 30, onFinish: true, onFailure: true },
  summaries: { morning: "09:00", evening: "" },
  maxCheckinsPerHour: 6,
  maxCheckinsPerDay: 100,
  act: { nudge: true, resumeRestart: true, readOnlyApprovals: false, handOutWork: false },
};

const LEVELS: readonly OversightLevel[] = ["watch", "suggest", "act"];

type Doc = Record<string, unknown>;

const table = (v: unknown): Doc => (v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {});
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const count = (v: unknown, d: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : d);
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
  return {
    enabled: bool(o.enabled, d.enabled),
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
    },
    summaries: { morning: time(summaries.morning, d.summaries.morning), evening: time(summaries.evening, d.summaries.evening) },
    maxCheckinsPerHour: count(o.max_checkins_per_hour, d.maxCheckinsPerHour) || d.maxCheckinsPerHour,
    maxCheckinsPerDay: count(o.max_checkins_per_day, d.maxCheckinsPerDay) || d.maxCheckinsPerDay,
    act: {
      nudge: bool(act.nudge, d.act.nudge),
      resumeRestart: bool(act.resume_restart, d.act.resumeRestart),
      readOnlyApprovals: bool(act.read_only_approvals, d.act.readOnlyApprovals),
      handOutWork: bool(act.hand_out_work, d.act.handOutWork),
    },
  };
};

/** The config with `o` as its `[oversight]`; anything else in the file, and
 *  any key of `[oversight]` Desk doesn't know, stays. */
export const withOversight = (source: string, o: Oversight): string => {
  const doc = (source.trim() ? parse(source) : {}) as Doc;
  const was = table(doc.oversight);
  doc.oversight = {
    ...was,
    enabled: o.enabled,
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
    },
  };
  return stringify(doc) + "\n";
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
