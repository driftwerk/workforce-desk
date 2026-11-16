import { parse, stringify } from "smol-toml";
import type { DeskHub } from "../hub/client";

// How and when a boss tells you what happened: its `[oversight.updates]`
// cadence keys, as the hub reads them (unsaid, Balanced). Each kind of news
// comes right away, waits for the roundup, or is said only when you ask.

export type Route = "right_away" | "roundup" | "ask";
export type RoundupEvery = "30m" | "1h" | "2h" | "meals" | "never";
export type Decided = "important" | "important_right_away" | "all" | "ask";
export type PresetName = "as_it_happens" | "balanced" | "roundups_only";
export type Row =
  "needs_you" | "problems" | "finished" | "progress" | "routine";

export interface Cadence {
  needs_you: Route;
  problems: Route;
  finished: Route;
  progress: Route;
  routine: Route;
  roundup: RoundupEvery;
  /** "22:00" to "07:00"; null for none. */
  quiet: { from: string; until: string } | null;
  /** In the quiet hours, what needs you still comes at once. */
  quietNeedsYou: boolean;
  decisions: Decided;
}

export const ROWS: readonly { key: Row; title: string; about: string }[] = [
  {
    key: "needs_you",
    title: "Needs you",
    about: "A question only you can answer, or a pause only you can lift",
  },
  {
    key: "problems",
    title: "Problems",
    about: "Stuck, failed, out of plan, or running low",
  },
  {
    key: "finished",
    title: "Finished",
    about: "Work merged, released or closed",
  },
  {
    key: "progress",
    title: "Progress",
    about: "A step done, a restart, work moving on",
  },
  {
    key: "routine",
    title: "Routine",
    about: "Nudges, checks, “left it alone”",
  },
];

export const ROUTES: readonly { key: Route; title: string }[] = [
  { key: "right_away", title: "Right away" },
  { key: "roundup", title: "In the roundup" },
  { key: "ask", title: "Only if I ask" },
];

export const EVERY: readonly { key: RoundupEvery; title: string }[] = [
  { key: "30m", title: "Every 30 minutes" },
  { key: "1h", title: "Every hour" },
  { key: "2h", title: "Every 2 hours" },
  { key: "meals", title: "Morning, lunch and end of day" },
  { key: "never", title: "Never — only right-away items" },
];

export const DECIDED: readonly { key: Decided; title: string }[] = [
  { key: "important", title: "The important ones, in each roundup" },
  { key: "important_right_away", title: "The important ones, right away" },
  { key: "all", title: "Every decision, in each roundup" },
  { key: "ask", title: "Only when I ask" },
];

export const PRESETS: readonly { key: PresetName; title: string }[] = [
  { key: "as_it_happens", title: "As it happens" },
  { key: "balanced", title: "Balanced" },
  { key: "roundups_only", title: "Roundups only" },
];

const ROW_SETS: Record<
  PresetName,
  { rows: [Route, Route, Route, Route, Route]; roundup: RoundupEvery }
> = {
  as_it_happens: {
    rows: ["right_away", "right_away", "right_away", "right_away", "ask"],
    roundup: "never",
  },
  balanced: {
    rows: ["right_away", "right_away", "roundup", "roundup", "ask"],
    roundup: "1h",
  },
  roundups_only: {
    rows: ["right_away", "roundup", "roundup", "roundup", "ask"],
    roundup: "1h",
  },
};

export const BALANCED: Cadence = {
  needs_you: "right_away",
  problems: "right_away",
  finished: "roundup",
  progress: "roundup",
  routine: "ask",
  roundup: "1h",
  quiet: { from: "22:00", until: "07:00" },
  quietNeedsYou: true,
  decisions: "important",
};

/** `c` with preset `p`'s five rows and roundup; the rest as it was. */
export const withPreset = (c: Cadence, p: PresetName): Cadence => {
  const { rows, roundup } = ROW_SETS[p];
  return {
    ...c,
    needs_you: rows[0],
    problems: rows[1],
    finished: rows[2],
    progress: rows[3],
    routine: rows[4],
    roundup,
  };
};

/** The preset `c`'s rows and roundup are; null: Custom. */
export const presetOf = (c: Cadence): PresetName | null =>
  PRESETS.find(({ key }) => {
    const { rows, roundup } = ROW_SETS[key];
    return ROWS.every((r, i) => c[r.key] === rows[i]) && c.roundup === roundup;
  })?.key ?? null;

type Doc = Record<string, unknown>;
const table = (v: unknown): Doc =>
  v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)
    ? (v as Doc)
    : {};
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const route = (v: unknown, d: Route, ask = true): Route =>
  v === "right_away" || v === "roundup" || (ask && v === "ask") ? v : d;

/** The cadence an agent's config says, Balanced where it says nothing (or
 *  something the hub wouldn't take). */
export const cadenceOf = (source: string): Cadence => {
  let doc: Doc = {};
  try {
    doc = source.trim() ? (parse(source) as Doc) : {};
  } catch {
    return BALANCED;
  }
  const u = table(table(doc.oversight).updates);
  const d = BALANCED;
  const quiet = (): Cadence["quiet"] => {
    if (!("quiet_hours" in u)) return d.quiet;
    const q = typeof u.quiet_hours === "string" ? u.quiet_hours.trim() : "";
    const [from, until] = q.split("-").map((x) => x.trim());
    return from &&
      until &&
      TIME.test(from) &&
      TIME.test(until) &&
      from !== until
      ? { from, until }
      : null;
  };
  return {
    needs_you: route(u.needs_you, d.needs_you, false),
    problems: route(u.problems, d.problems),
    finished: route(u.finished, d.finished),
    progress: route(u.progress, d.progress),
    routine: route(u.routine, d.routine),
    roundup: EVERY.some((e) => e.key === u.roundup)
      ? (u.roundup as RoundupEvery)
      : d.roundup,
    quiet: quiet(),
    quietNeedsYou:
      typeof u.quiet_needs_you === "boolean"
        ? u.quiet_needs_you
        : d.quietNeedsYou,
    decisions: DECIDED.some((x) => x.key === u.decisions)
      ? (u.decisions as Decided)
      : d.decisions,
  };
};

/** What is wrong with `c` as the hub would say it; null when nothing is. */
export const problemOf = (c: Cadence): string | null => {
  if (c.roundup !== "never") return null;
  const waiting = ROWS.filter((r) => c[r.key] === "roundup").map((r) =>
    r.title.toLowerCase(),
  );
  if (!waiting.length) return null;
  return `With no roundups, ${waiting.join(" and ")} would never be told: send ${waiting.length === 1 ? "it" : "them"} right away or only if you ask, or choose how often the roundup comes.`;
};

/** The config with `c` as its cadence keys; everything else as it was. */
export const withCadence = (source: string, c: Cadence): string => {
  const doc = (source.trim() ? parse(source) : {}) as Doc;
  const oversight = table(doc.oversight);
  doc.oversight = {
    ...oversight,
    updates: {
      ...table(oversight.updates),
      needs_you: c.needs_you,
      problems: c.problems,
      finished: c.finished,
      progress: c.progress,
      routine: c.routine,
      roundup: c.roundup,
      quiet_hours: c.quiet ? `${c.quiet.from}-${c.quiet.until}` : "",
      quiet_needs_you: c.quietNeedsYou,
      decisions: c.decisions,
    },
  };
  return stringify(doc) + "\n";
};

/** Writes `change` of the agent's cadence into its config as it is now (read
 *  fresh, so nothing else is lost); answers with the config written. */
export async function setAgentCadence(
  hub: DeskHub,
  id: string,
  change: (c: Cadence) => Cadence,
): Promise<string> {
  const source = await hub.agentConfig(id);
  try {
    if (source.trim()) parse(source);
  } catch {
    throw new Error(
      "Their settings file has a mistake in it, so Desk won’t change it.",
    );
  }
  const next = change(cadenceOf(source));
  const problem = problemOf(next);
  if (problem) throw new Error(problem);
  const toml = withCadence(source, next);
  await hub.saveAgentConfig(id, toml);
  return toml;
}

const EVERY_SAID: Record<RoundupEvery, string> = {
  "30m": "Every 30 minutes",
  "1h": "Every hour",
  "2h": "Every 2 hours",
  meals: "At morning, lunch and end of day",
  never: "No roundups",
};

const ROW_SAID: Record<Row, string> = {
  needs_you: "anything that needs you",
  problems: "problems",
  finished: "finished work",
  progress: "progress",
  routine: "routine nudges and checks",
};

const list = (xs: string[]): string =>
  xs.length <= 1
    ? xs.join("")
    : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** The card's summary: a label and what it covers, each line. */
export const summaryOf = (c: Cadence): { label: string; text: string }[] => {
  const of = (r: Route) =>
    ROWS.filter((x) => c[x.key] === r).map((x) => ROW_SAID[x.key]);
  const out: { label: string; text: string }[] = [];
  const now = of("right_away");
  if (now.length) out.push({ label: "Right away:", text: list(now) });
  const later = of("roundup");
  if (c.roundup === "never") out.push({ label: "No roundups", text: "" });
  else if (later.length)
    out.push({ label: `${EVERY_SAID[c.roundup]}:`, text: list(later) });
  else
    out.push({
      label: `Roundups ${EVERY_SAID[c.roundup].toLowerCase()}`,
      text: "",
    });
  out.push({
    label: "Decided without you:",
    text: {
      important: "the important ones, in the roundup",
      important_right_away: "the important ones, right away",
      all: "every one, in the roundup",
      ask: "only when you ask",
    }[c.decisions],
  });
  const ask = of("ask");
  if (ask.length) out.push({ label: "Only if you ask:", text: list(ask) });
  if (c.quiet)
    out.push({
      label: `Quiet ${c.quiet.from}–${c.quiet.until}:`,
      text: c.quietNeedsYou
        ? "held for the morning, except what needs you"
        : "everything held for the morning",
    });
  return out;
};
