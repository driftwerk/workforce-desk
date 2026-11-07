import { BUILTIN } from "../theme/builtin";
import { slug } from "../theme/toml";
import { isDarkGround, type Palette, type ThemeSpec, type Token } from "../theme/tokens";

export interface Swatch {
  label: string;
  hex: string;
}

export const BACKGROUNDS: readonly Swatch[] = [
  { label: "Ink", hex: "#111210" },
  { label: "Harbour", hex: "#0E1822" },
  { label: "Plum", hex: "#1A1423" },
  { label: "Paper", hex: "#FBFAF7" },
  { label: "Linen", hex: "#F6F6F1" },
  { label: "White", hex: "#FFFFFF" },
  { label: "Mist", hex: "#EEF2F6" },
];

/** Signals for a dark background: brights that read on it. */
export const SIGNALS: readonly Swatch[] = [
  { label: "Signal", hex: "#D4FF3A" },
  { label: "Ember", hex: "#FF9F6B" },
  { label: "Sky", hex: "#7DD3FC" },
  { label: "Lavender", hex: "#C4B5FD" },
  { label: "Rose", hex: "#FF6B9A" },
  { label: "Ink", hex: "#161714" },
];

/** Signals for a light background: deep enough to be text on it, and to
 *  carry light text as a fill. */
export const LIGHT_SIGNALS: readonly Swatch[] = [
  { label: "Olive", hex: "#3F5A06" },
  { label: "Sky", hex: "#1F5FBF" },
  { label: "Ember", hex: "#B4440F" },
  { label: "Lavender", hex: "#5B45C9" },
  { label: "Rose", hex: "#B02A5B" },
  { label: "Ink", hex: "#1B1C18" },
];

/** The signals the editor offers for `background`. */
export const signalsFor = (background: string): readonly Swatch[] => (isDarkGround(background) ? SIGNALS : LIGHT_SIGNALS);

/** Every token the background, signal and text don't set directly. */
export const DERIVED: readonly [Token, string][] = [
  ["surface", "surface"],
  ["raised", "raised"],
  ["sunken", "terminal"],
  ["border", "border"],
  ["muted", "muted"],
  ["faint", "faint"],
  ["onSignal", "on signal"],
  ["signalSoft", "soft"],
  ["signalSoftText", "soft text"],
  ["working", "working"],
  ["blocked", "needs you"],
  ["onBlocked", "on needs you"],
  ["blockedSoft", "needs you soft"],
  ["done", "done"],
  ["idle", "idle"],
  ["termText", "terminal text"],
  ["termCursor", "terminal cursor"],
  ["termSelection", "terminal selection"],
  ["ansiBlack", "black"],
  ["ansiRed", "red"],
  ["ansiGreen", "green"],
  ["ansiYellow", "yellow"],
  ["ansiBlue", "blue"],
  ["ansiMagenta", "magenta"],
  ["ansiCyan", "cyan"],
  ["ansiWhite", "white"],
  ["ansiBrightBlack", "bright black"],
  ["ansiBrightRed", "bright red"],
  ["ansiBrightGreen", "bright green"],
  ["ansiBrightYellow", "bright yellow"],
  ["ansiBrightBlue", "bright blue"],
  ["ansiBrightMagenta", "bright magenta"],
  ["ansiBrightCyan", "bright cyan"],
  ["ansiBrightWhite", "bright white"],
  ["handle", "drag handle"],
  ["handleActive", "drag handle, active"],
  ["diffAdd", "added lines"],
  ["diffDel", "removed lines"],
  ["shadow", "shadow"],
  ["lift", "lift"],
  ["edge", "edge"],
  ["logoDot", "logo dot"],
  ["onMark", "on marks"],
  ["mark1", "mark 1"],
  ["mark2", "mark 2"],
  ["mark3", "mark 3"],
  ["mark4", "mark 4"],
  ["mark5", "mark 5"],
  ["mark6", "mark 6, engines"],
  ["series1", "chart 1"],
  ["series2", "chart 2"],
  ["series3", "chart 3"],
  ["series4", "chart 4"],
  ["series5", "chart 5"],
  ["series6", "chart 6"],
  ["series7", "chart 7"],
  ["series8", "chart 8"],
  ["buttonFill", "button"],
  ["approve", "answer button"],
  ["onApprove", "on answer button"],
  ["askGlow", "ask glow"],
  ["focusRing", "focus ring"],
  ["activeEdge", "active edge"],
  ["activeRing", "active ring"],
  ["cardFill", "settings card"],
  ["modeGround", "look switcher"],
  ["modeFill", "chosen look"],
  ["onModeFill", "on chosen look"],
];

/** How the editor sets the derived colours out: by what they colour. */
const GROUP_OF: Partial<Record<Token, string>> = {
  working: "States",
  blocked: "States",
  onBlocked: "States",
  blockedSoft: "States",
  done: "States",
  idle: "States",
  buttonFill: "Buttons and focus",
  approve: "Buttons and focus",
  onApprove: "Buttons and focus",
  askGlow: "Buttons and focus",
  focusRing: "Buttons and focus",
  modeGround: "Buttons and focus",
  modeFill: "Buttons and focus",
  onModeFill: "Buttons and focus",
  activeEdge: "Depth",
  activeRing: "Depth",
  shadow: "Depth",
  lift: "Depth",
  edge: "Depth",
  logoDot: "Logo and marks",
  onMark: "Logo and marks",
  mark1: "Logo and marks",
  mark2: "Logo and marks",
  mark3: "Logo and marks",
  mark4: "Logo and marks",
  mark5: "Logo and marks",
  mark6: "Logo and marks",
};

const groupOf = (t: Token): string =>
  GROUP_OF[t] ?? (t.startsWith("term") || t.startsWith("ansi") || t.startsWith("diff") ? "Terminal and code" : t.startsWith("series") ? "Charts" : "Panels and text");

/** `DERIVED`, grouped, in the order the groups first appear. */
export const derivedGroups = (): { label: string; tokens: [Token, string][] }[] => {
  const groups = new Map<string, [Token, string][]>();
  for (const row of DERIVED) {
    const g = groupOf(row[0]);
    groups.set(g, [...(groups.get(g) ?? []), row]);
  }
  return [...groups].map(([label, tokens]) => ({ label, tokens }));
};

export const isBuiltin = (id: string): boolean => BUILTIN.some((b) => b.id === id);

export const uniqueId = (name: string, taken: readonly string[]): string => {
  const base = slug(name);
  let id = base;
  for (let n = 2; taken.includes(id) || id === "system"; n++) id = `${base}-${n}`;
  return id;
};

export const copyOf = (spec: ThemeSpec, taken: readonly string[], name = `${spec.name} copy`): ThemeSpec => ({
  ...spec,
  id: uniqueId(name, taken),
  name,
  overrides: { ...spec.overrides },
  fonts: { ...spec.fonts },
});

const BASE = [
  ["background", "bg"],
  ["signal", "signal"],
  ["text", "text"],
] as const;

/** Overrides copied from a built-in are tuned to its colours, so they go
 *  once the background, signal or text moves away from them. */
const released = (spec: ThemeSpec): Partial<Palette> => {
  const origin = BUILTIN.find((b) => b.background === spec.background);
  if (!origin) return spec.overrides;
  return Object.fromEntries(Object.entries(spec.overrides).filter(([k, v]) => origin.overrides[k as Token] !== v));
};

/** Built-ins are read-only, so the first edit to one makes a copy. */
export const applyEdit = (spec: ThemeSpec, patch: Partial<ThemeSpec>, taken: readonly string[]): ThemeSpec => {
  const base = isBuiltin(spec.id) ? copyOf(spec, taken) : spec;
  const moved = BASE.filter(([k, token]) => k in patch && (patch[k] !== spec[k] || token in spec.overrides));
  const overrides = { ...(patch.overrides ?? (moved.length ? released(base) : base.overrides)) };
  for (const [, token] of moved) delete overrides[token];
  return { ...base, ...patch, id: base.id, overrides };
};

export const withOverride = (spec: ThemeSpec, token: Token, hex: string | null): Partial<Palette> => {
  const overrides = { ...spec.overrides };
  if (hex) overrides[token] = hex;
  else delete overrides[token];
  return overrides;
};

export const upsert = (list: readonly ThemeSpec[], spec: ThemeSpec): ThemeSpec[] =>
  list.some((t) => t.id === spec.id) ? list.map((t) => (t.id === spec.id ? spec : t)) : [...list, spec];
