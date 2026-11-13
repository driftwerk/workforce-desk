import type { Oversight } from "./oversight";

/** The levels the person picks from, each with the switches it implies.
 *  Act fully is unbound: every switch on, anywhere, and Desk allows every
 *  request its sessions ask at once (the hub holds it to that whatever
 *  its switches say). */
export type Preset = "watch" | "suggest" | "act" | "full";

export const PRESETS: readonly Preset[] = ["watch", "suggest", "act", "full"];

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

/** `o` at `preset`, overseeing: its level and the switches the level
 *  implies (every one, anywhere, at Act fully). Repos, workflows and the
 *  budget are kept as they are. */
export const withPreset = (o: Oversight, preset: Preset): Oversight => ({
  ...o,
  enabled: true,
  level: preset,
  act: preset === "full" ? ALL_ON : ACT_SWITCHES,
  full: { ...o.full, anywhere: preset === "full" },
});

/** The preset `o` is at, or null when its switches were changed from what
 *  its level implies (under Advanced). */
export const presetOf = (o: Oversight): Preset | null => {
  const same = (a: Oversight["act"]) =>
    (Object.keys(a) as (keyof Oversight["act"])[]).every(
      (k) => a[k] === o.act[k],
    );
  if (o.level === "act" && same(ACT_SWITCHES)) return "act";
  // Below Act, and at Act fully (unbound), the switches do nothing, so any
  // of them is the level.
  if (o.level === "watch" || o.level === "suggest" || o.level === "full")
    return o.level;
  return null;
};

/** The level a preset's card is shown at: the one it is, else its level
 *  (Act with switches changed). */
export const shownPreset = (o: Oversight): Preset => presetOf(o) ?? o.level;

export const PRESET_NAME: Record<Preset, string> = {
  watch: "Watch",
  suggest: "Suggest",
  act: "Act",
  full: "Act fully",
};

/** What each preset does, said for `name`. */
export const presetDesc = (preset: Preset): string =>
  ({
    watch:
      "Answers “what’s everyone doing?” and tells you when something needs you.",
    suggest: "Also proposes what to do. Nothing happens until you say yes.",
    act: "Does the work itself: starts and runs sessions, nudges, answers and approves reads. Messaging agents and other terminals stays yours.",
    full: "Does everything itself, in any repo: Desk allows every request its sessions ask at once. Only your budget, Stop and the activity log hold it.",
  })[preset];
