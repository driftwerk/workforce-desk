import { BUILTIN } from "../theme/builtin";
import { slug } from "../theme/toml";
import type { Palette, ThemeSpec, Token } from "../theme/tokens";

export interface Swatch {
  label: string;
  hex: string;
}

export const BACKGROUNDS: readonly Swatch[] = [
  { label: "Ink", hex: "#111210" },
  { label: "Harbour", hex: "#0E1822" },
  { label: "Plum", hex: "#1A1423" },
  { label: "Paper", hex: "#F6F6F1" },
  { label: "White", hex: "#FFFFFF" },
  { label: "Mist", hex: "#EEF2F6" },
];

export const SIGNALS: readonly Swatch[] = [
  { label: "Signal", hex: "#D4FF3A" },
  { label: "Ember", hex: "#FF9F6B" },
  { label: "Sky", hex: "#7DD3FC" },
  { label: "Lavender", hex: "#C4B5FD" },
  { label: "Rose", hex: "#FF6B9A" },
  { label: "Ink", hex: "#161714" },
];

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
  ["ansiRed", "red"],
  ["ansiGreen", "green"],
  ["ansiCyan", "cyan"],
];

export const FONTS = [
  "Bricolage Grotesque Variable",
  "Figtree Variable",
  "Geist Mono Variable",
  "SF Pro",
  "Helvetica Neue",
  "Avenir Next",
  "SF Mono",
  "Menlo",
] as const;

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
