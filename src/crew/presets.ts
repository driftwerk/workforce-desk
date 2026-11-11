import type { Oversight } from "./oversight";

/** The levels the person picks from, each with the switches it implies:
 *  Unbound is Act fully with every switch on, anywhere. */
export type Preset = "watch" | "suggest" | "act" | "full" | "unbound";

export const PRESETS: readonly Preset[] = [
  "watch",
  "suggest",
  "act",
  "full",
  "unbound",
];

/** The switches Act turns on: what it needs to do the work itself inside
 *  Desk. The four left off reach outside Desk or loosen the person's own
 *  controls (agents act under their own permissions, sessions from other
 *  terminals may not ask, another engine's vendor gets the brief, a
 *  session's permission mode is the person's), so they stay the person's
 *  to switch on, under Advanced. */
export const ACT_SWITCHES: Oversight["act"] = {
  nudge: true,
  resumeRestart: true,
  readOnlyApprovals: true,
  handOutWork: true,
  interrupt: true,
  answerSessions: true,
  messageAgents: false,
  messageTerminalSessions: false,
  handOff: false,
  setMode: false,
};

const ALL_ON: Oversight["act"] = {
  nudge: true,
  resumeRestart: true,
  readOnlyApprovals: true,
  handOutWork: true,
  interrupt: true,
  answerSessions: true,
  messageAgents: true,
  messageTerminalSessions: true,
  handOff: true,
  setMode: true,
};

/** `o` at `preset`, overseeing: its level, the switches the level implies
 *  and, for Act fully and Unbound, whether it is limited to its repos.
 *  Repos, workflows and the budget are kept as they are. */
export const withPreset = (o: Oversight, preset: Preset): Oversight => {
  const level = preset === "unbound" ? "full" : preset;
  return {
    ...o,
    enabled: true,
    level,
    act: preset === "unbound" ? ALL_ON : ACT_SWITCHES,
    full: { ...o.full, anywhere: preset === "unbound" },
  };
};

/** The preset `o` is at, or null when its switches were changed from what
 *  its level implies (under Advanced). */
export const presetOf = (o: Oversight): Preset | null => {
  const same = (a: Oversight["act"]) =>
    (Object.keys(a) as (keyof Oversight["act"])[]).every(
      (k) => a[k] === o.act[k],
    );
  if (o.level === "full" && o.full.anywhere && same(ALL_ON)) return "unbound";
  if (o.level === "full" && !o.full.anywhere && same(ACT_SWITCHES))
    return "full";
  if (o.level === "act" && same(ACT_SWITCHES)) return "act";
  // Below Act the switches do nothing, so any of them is the level.
  if (o.level === "watch" || o.level === "suggest") return o.level;
  return null;
};

/** The level a preset's card is shown at: the one it is, else the nearest
 *  (Act or Act fully with switches changed). */
export const shownPreset = (o: Oversight): Preset =>
  presetOf(o) ??
  (o.level === "full"
    ? o.full.anywhere
      ? "unbound"
      : "full"
    : o.level === "act"
      ? "act"
      : o.level);

export const PRESET_NAME: Record<Preset, string> = {
  watch: "Watch",
  suggest: "Suggest",
  act: "Act",
  full: "Act fully",
  unbound: "Unbound",
};

/** What each preset does, said for `name`. */
export const presetDesc = (preset: Preset): string =>
  ({
    watch:
      "Answers “what’s everyone doing?” and tells you when something needs you.",
    suggest: "Also proposes what to do. Nothing happens until you say yes.",
    act: "Does the work itself: starts and runs sessions, nudges, answers and approves reads. Messaging agents and other terminals stays yours.",
    full: "As Act, and merges, tags, releases and runs your named workflows in the repos you name, under a daily budget.",
    unbound:
      "Does everything itself, in any repo, with every switch on. Only your budget, Stop and the activity log hold it.",
  })[preset];
