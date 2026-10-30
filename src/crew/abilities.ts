import { parse, stringify } from "smol-toml";
import type { DeskHub } from "../hub/client";

/** How an agent remembers, works and checks in: what its own `config.toml`
 *  says, Desk's defaults (the hub-wide ones Desk Helper writes) where it
 *  says nothing. */
export interface Abilities {
  /** `[memory] passive`. */
  passive: boolean;
  /** `[memory] lesson_extract` and `lesson_inject`, together. */
  lessons: boolean;
  /** `[self_learning] enabled`. */
  learn: boolean;
  /** `[memory] consolidation`, every `tidyEvery` seconds. */
  tidy: boolean;
  tidyEvery: number;
  /** `[memory] relationship`. */
  rapport: boolean;
  /** `[advisor] enabled`, its `cc_effort`, and `[advisor.fanout] max_lenses`. */
  advisor: boolean;
  advisorEffort: AdvisorEffort;
  angles: number;
  /** `[claim_grounding] enabled`. */
  grounding: boolean;
  /** `[tools.programs] enabled`. */
  programs: boolean;
  /** `[know_how]`: off, collecting only (`inject = "shadow"`), or used. */
  knowHow: KnowHow;
  /** `[heartbeat]`: on, how often, and quiet hours ("" for none). */
  heartbeat: boolean;
  heartbeatEvery: number;
  quietFrom: string;
  quietTo: string;
}

export type AdvisorEffort = "medium" | "high" | "max";
export type KnowHow = "off" | "shadow" | "on";

/** At most this many Claude Code runs at once on this computer (Desk Helper's
 *  `hub_max_concurrent_cc`): more angles than that would wait on each other. */
export const MAX_ANGLES = 3;

/** What every local agent does unless its own file says otherwise: the
 *  hub-wide config Desk Helper writes (crates/desk-hubd/src/config.rs). */
export const DESK_DEFAULTS: Abilities = {
  passive: true,
  lessons: true,
  learn: true,
  tidy: true,
  tidyEvery: 7200,
  rapport: true,
  advisor: true,
  advisorEffort: "high",
  angles: MAX_ANGLES,
  grounding: true,
  programs: true,
  knowHow: "shadow",
  heartbeat: false,
  heartbeatEvery: 3600,
  quietFrom: "",
  quietTo: "",
};

export const TIDY_EVERY: { secs: number; name: string }[] = [
  { secs: 3600, name: "hour" },
  { secs: 7200, name: "2 hours" },
  { secs: 14400, name: "4 hours" },
  { secs: 86400, name: "day" },
];

export const HEARTBEAT_EVERY: { secs: number; name: string }[] = [
  { secs: 900, name: "15 minutes" },
  { secs: 1800, name: "30 minutes" },
  { secs: 3600, name: "hour" },
  { secs: 14400, name: "4 hours" },
];

export const ADVISOR_EFFORTS: AdvisorEffort[] = ["medium", "high", "max"];

/** The switches of "How they remember", which "Back to Desk's defaults"
 *  puts back. */
export const REMEMBER: (keyof Abilities)[] = ["passive", "lessons", "learn", "tidy", "tidyEvery", "rapport"];

type Doc = Record<string, unknown>;

const table = (v: unknown): Doc => (v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {});
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const parseDoc = (source: string): Doc => {
  try {
    return source.trim() ? (parse(source) as Doc) : {};
  } catch {
    return {};
  }
};

/** What an agent's config says, Desk's defaults where it says nothing (or
 *  something Desk can't use). */
export const abilitiesOf = (source: string): Abilities => {
  const doc = parseDoc(source);
  const d = DESK_DEFAULTS;
  const memory = table(doc.memory);
  const learning = table(doc.self_learning);
  const advisor = table(doc.advisor);
  const fanout = table(advisor.fanout);
  const grounding = table(doc.claim_grounding);
  const programs = table(table(doc.tools).programs);
  const knowHow = table(doc.know_how);
  const heartbeat = table(doc.heartbeat);
  const extract = bool(memory.lesson_extract, d.lessons);
  const inject = bool(memory.lesson_inject, d.lessons);
  const every = memory.consolidation_interval_secs;
  const effort = advisor.cc_effort;
  const angles = fanout.max_lenses;
  const hbEvery = heartbeat.interval_secs;
  return {
    passive: bool(memory.passive, d.passive),
    lessons: extract && inject,
    // A per-agent `[self_learning]` replaces the hub's whole: without
    // `enabled` it is off.
    learn: "self_learning" in doc ? bool(learning.enabled, false) : d.learn,
    tidy: bool(memory.consolidation, d.tidy),
    tidyEvery: typeof every === "number" && every > 0 ? every : d.tidyEvery,
    rapport: bool(memory.relationship, d.rapport),
    advisor: bool(advisor.enabled, d.advisor),
    advisorEffort: ADVISOR_EFFORTS.includes(effort as AdvisorEffort) ? (effort as AdvisorEffort) : d.advisorEffort,
    angles: typeof angles === "number" && Number.isInteger(angles) && angles >= 1 ? Math.min(angles, MAX_ANGLES) : d.angles,
    // As with `[self_learning]`, the agent's section is the whole of it.
    grounding: "claim_grounding" in doc ? bool(grounding.enabled, false) : d.grounding,
    programs: bool(programs.enabled, d.programs),
    knowHow: !bool(knowHow.enabled, true)
      ? "off"
      : knowHow.inject === "on" || knowHow.inject === "shadow"
        ? (knowHow.inject as KnowHow)
        : knowHow.inject === "off"
          ? "off"
          : d.knowHow,
    heartbeat: bool(heartbeat.enabled, d.heartbeat),
    heartbeatEvery: typeof hbEvery === "number" && hbEvery > 0 ? hbEvery : d.heartbeatEvery,
    quietFrom: typeof heartbeat.quiet_start === "string" && TIME.test(heartbeat.quiet_start) ? heartbeat.quiet_start : d.quietFrom,
    quietTo: typeof heartbeat.quiet_end === "string" && TIME.test(heartbeat.quiet_end) ? heartbeat.quiet_end : d.quietTo,
  };
};

/** Whether any of "How they remember" differs from Desk's defaults. */
export const rememberDiffers = (a: Abilities): boolean => REMEMBER.some((k) => a[k] !== DESK_DEFAULTS[k]);

/** `value` at `key` of `t`, or no `key` when it is Desk's default. */
const put = (t: Doc, key: string, value: unknown, fallback: unknown) => {
  if (value === fallback) delete t[key];
  else t[key] = value;
};

/** `t` at `key` of `doc` when it holds anything, else no `key`. */
const keep = (doc: Doc, key: string, t: Doc) => {
  if (Object.keys(t).length > 0) doc[key] = t;
  else delete doc[key];
};

/** The config with `a`: a setting the same as Desk's default is left out,
 *  so the agent follows Desk's defaults there; anything else in the file
 *  stays as it is. */
export const withAbilities = (source: string, a: Abilities): string => {
  const doc = (source.trim() ? parse(source) : {}) as Doc;
  const before = JSON.stringify(doc);
  const d = DESK_DEFAULTS;

  const memory = { ...table(doc.memory) };
  put(memory, "passive", a.passive, d.passive);
  put(memory, "lesson_extract", a.lessons, d.lessons);
  put(memory, "lesson_inject", a.lessons, d.lessons);
  put(memory, "consolidation", a.tidy, d.tidy);
  put(memory, "consolidation_interval_secs", a.tidyEvery, d.tidyEvery);
  put(memory, "relationship", a.rapport, d.rapport);
  keep(doc, "memory", memory);

  // `[self_learning]` and `[claim_grounding]` replace the hub's whole: an
  // agent's section is written only to turn them off, and `enabled = true`
  // is kept where the section holds anything else.
  const whole = (key: string, on: boolean, fallback: boolean) => {
    const t = { ...table(doc[key]) };
    if (on === fallback) {
      delete t.enabled;
      if (Object.keys(t).length > 0) t.enabled = on;
    } else t.enabled = on;
    keep(doc, key, t);
  };
  whole("self_learning", a.learn, d.learn);
  whole("claim_grounding", a.grounding, d.grounding);

  const advisor = { ...table(doc.advisor) };
  put(advisor, "enabled", a.advisor, d.advisor);
  put(advisor, "cc_effort", a.advisorEffort, d.advisorEffort);
  const fanout = { ...table(advisor.fanout) };
  // A panel's angles each need a place, so the agent's own limit follows.
  put(fanout, "max_lenses", a.angles, d.angles);
  put(fanout, "max_concurrent", a.angles, d.angles);
  keep(advisor, "fanout", fanout);
  keep(doc, "advisor", advisor);

  const tools = { ...table(doc.tools) };
  const programs = { ...table(tools.programs) };
  put(programs, "enabled", a.programs, d.programs);
  keep(tools, "programs", programs);
  keep(doc, "tools", tools);

  const knowHow = { ...table(doc.know_how) };
  if (a.knowHow === "off") {
    knowHow.enabled = false;
    delete knowHow.inject;
  } else {
    delete knowHow.enabled;
    put(knowHow, "inject", a.knowHow, d.knowHow);
  }
  keep(doc, "know_how", knowHow);

  const heartbeat = { ...table(doc.heartbeat) };
  put(heartbeat, "enabled", a.heartbeat, d.heartbeat);
  put(heartbeat, "interval_secs", a.heartbeatEvery, d.heartbeatEvery);
  put(heartbeat, "quiet_start", a.quietFrom, d.quietFrom);
  put(heartbeat, "quiet_end", a.quietTo, d.quietTo);
  keep(doc, "heartbeat", heartbeat);

  // Unchanged, the file is left exactly as it was, comments and all.
  if (JSON.stringify(doc) === before) return source;
  const out = stringify(doc).trim();
  return out ? out + "\n" : "";
};

/** `a` with every "How they remember" setting back at Desk's default. */
export const rememberDefaults = (a: Abilities): Abilities => ({
  ...a,
  ...Object.fromEntries(REMEMBER.map((k) => [k, DESK_DEFAULTS[k]])),
});

/** Writes `change` of the agent's abilities into its config as it is now
 *  (read fresh, so nothing else in it is lost); answers with the config as
 *  written. */
export async function setAgentAbilities(hub: DeskHub, id: string, change: (a: Abilities) => Abilities): Promise<string> {
  const source = await hub.agentConfig(id);
  if (source.trim()) {
    try {
      parse(source);
    } catch {
      throw new Error("Their settings file has a mistake in it, so Desk won’t change it.");
    }
  }
  const toml = withAbilities(source, change(abilitiesOf(source)));
  await hub.saveAgentConfig(id, toml);
  return toml;
}
