/** Every colour a theme has. Each can be overridden under
 *  `[colors.override]` in a theme's TOML; those not set are derived from
 *  the background, signal and text (see `derive`):
 *  - `handle`: drag handles at rest (a column's resize grip, the edges
 *    between grid panes) — the border colour unless set.
 *  - `handleActive`: a drag handle hovered, dragged or focused — the
 *    signal colour unless set. */
export const TOKENS = [
  "bg",
  "surface",
  "raised",
  "sunken",
  "border",
  "text",
  "muted",
  "faint",
  "signal",
  "onSignal",
  "signalSoft",
  "signalSoftText",
  "working",
  "blocked",
  "onBlocked",
  "blockedSoft",
  "done",
  "idle",
  "termText",
  "ansiRed",
  "ansiGreen",
  "ansiCyan",
  "handle",
  "handleActive",
] as const;

export type Token = (typeof TOKENS)[number];
export type Palette = Record<Token, string>;

export type Density = "compact" | "cozy";
export type Corners = "sharp" | "soft" | "round";

export interface ThemeSpec {
  id: string;
  name: string;
  background: string;
  signal: string;
  text?: string;
  overrides: Partial<Palette>;
  /** `size` is the interface's; chats and documents have `chatSize`, code
   *  and terminals `codeSize`. */
  fonts: { display: string; ui: string; mono: string; size: number; chatSize: number; codeSize: number };
  density: Density;
  corners: Corners;
}

export type SizeRole = "size" | "chatSize" | "codeSize";

/** The sizes a theme may give each kind of text, in px. */
export const SIZE_RANGES: Record<SizeRole, readonly [number, number]> = {
  size: [10, 22],
  chatSize: [10, 24],
  codeSize: [9, 22],
};

export interface Theme {
  spec: ThemeSpec;
  dark: boolean;
  colors: Palette;
}

const HEX = /^#([0-9a-f]{6})$/i;

export const isHex = (value: string): boolean => HEX.test(value);

const rgb = (hex: string): [number, number, number] => {
  const h = hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};

const toHex = (c: readonly number[]): string =>
  "#" +
  c
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();

export const mix = (a: string, b: string, p: number): string => {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((v, i) => v + ((y[i] ?? 0) - v) * p));
};

export const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const contrast = (a: string, b: string): number => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const INK = "#161714";
const PAPER_TEXT = "#F1F2EC";

export const derive = (spec: ThemeSpec): Theme => {
  const bg = spec.background;
  const dark = luminance(bg) < 0.2;
  const text = spec.text ?? (dark ? PAPER_TEXT : INK);
  const signal = spec.signal;
  const signalSoft = mix(signal, bg, 0.78);
  const derived: Omit<Palette, "handle" | "handleActive"> = {
    bg,
    surface: mix(bg, text, 0.04),
    raised: mix(bg, text, 0.08),
    sunken: dark ? mix(bg, "#000000", 0.3) : mix(bg, "#FFFFFF", 0.6),
    border: mix(bg, text, 0.16),
    text,
    muted: mix(text, bg, 0.28),
    faint: mix(text, bg, 0.42),
    signal,
    onSignal: luminance(signal) > 0.35 ? INK : "#FFFFFF",
    signalSoft,
    signalSoftText:
      contrast(signal, signalSoft) >= 4.5 ? signal : dark ? mix(signal, "#FFFFFF", 0.45) : mix(signal, "#000000", 0.55),
    working: dark ? "#7DB8FF" : "#1D5FD1",
    blocked: dark ? "#FFB547" : "#A85A00",
    onBlocked: dark ? "#2B1B03" : "#FFFFFF",
    blockedSoft: dark ? mix(bg, "#FFB547", 0.12) : mix(bg, "#FFB547", 0.16),
    done: dark ? "#6EE7A8" : "#17803F",
    idle: mix(text, bg, 0.5),
    termText: mix(text, bg, 0.12),
    ansiRed: dark ? "#FF8A7A" : "#B42318",
    ansiGreen: dark ? "#A6E37A" : "#3F7A12",
    ansiCyan: dark ? "#8FD8E8" : "#0E7490",
  };
  const colors = { ...derived, ...spec.overrides };
  // The handles follow the border and signal as they end up, overrides
  // included, unless a theme sets them itself.
  return { spec, dark, colors: { ...colors, handle: spec.overrides.handle ?? colors.border, handleActive: spec.overrides.handleActive ?? colors.signal } };
};

const kebab = (token: string): string => token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export const RADII: Record<Corners, number> = { sharp: 4, soft: 14, round: 22 };

/** The CSS font stack code and terminals are drawn in. */
export const monoStack = (spec: ThemeSpec): string => `"${spec.fonts.mono}", ui-monospace, monospace`;

export const cssVariables = (theme: Theme): Record<string, string> => {
  const { colors, spec } = theme;
  const r = RADII[spec.corners];
  return {
    ...Object.fromEntries(TOKENS.map((t) => [`--${kebab(t)}`, colors[t]])),
    "--font-display": `"${spec.fonts.display}", system-ui, sans-serif`,
    "--font-ui": `"${spec.fonts.ui}", system-ui, sans-serif`,
    "--font-mono": monoStack(spec),
    "--font-size": `${spec.fonts.size}px`,
    "--font-size-chat": `${spec.fonts.chatSize}px`,
    "--font-size-code": `${spec.fonts.codeSize}px`,
    "--radius": `${r}px`,
    "--radius-lg": `${r + 6}px`,
    "--radius-sm": `${Math.max(4, r - 4)}px`,
    "--pad": spec.density === "compact" ? "10px" : "16px",
    "--gap": spec.density === "compact" ? "8px" : "14px",
    "--rich-bg": colors.bg,
    "--rich-surface": colors.raised,
    "--rich-text": colors.text,
    "--rich-muted": colors.muted,
    "--rich-border": colors.border,
    "--rich-accent": colors.signal,
    ...Object.fromEntries(SERIES.map((c, i) => [`--rich-series-${i + 1}`, c])),
    ...Object.fromEntries(Object.entries(codeColors(colors)).map(([k, v]) => [`--rich-code-${k}`, v])),
  };
};

/** Fenced code in agents' replies: drawn like the terminal panes (sunken ground,
 *  terminal text), with syntax colours taken from the palette's own status and
 *  ANSI colours, so a custom theme's overrides carry through to its code. */
export const codeColors = (c: Palette): Record<string, string> => ({
  bg: c.sunken,
  text: c.termText,
  comment: c.faint,
  keyword: c.ansiRed,
  string: c.ansiGreen,
  "string-expression": c.ansiGreen,
  constant: c.ansiCyan,
  function: c.working,
  parameter: c.blocked,
  punctuation: c.muted,
  link: c.working,
  inserted: c.done,
  deleted: c.ansiRed,
  changed: c.blocked,
});

export const MARKS = ["#C9B8FF", "#FFC98A", "#A8D8FF", "#A6EBC9", "#FFB3C7", "#E8DDB5"] as const;
const SERIES = [...MARKS, "#D4FF3A", "#8FD8E8"];

export const markFor = (name: string): string => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return MARKS[h % MARKS.length] ?? MARKS[0];
};

export interface ContrastCheck {
  label: string;
  ratio: number;
  pass: boolean;
}

export const contrastChecks = ({ colors: c }: Theme): ContrastCheck[] =>
  (
    [
      ["Text on background", c.text, c.bg],
      ["Secondary text on panels", c.muted, c.surface],
      ["Labels and timestamps", c.faint, c.bg],
      ["Button text on signal", c.onSignal, c.signal],
    ] as const
  ).map(([label, a, b]) => {
    const ratio = contrast(a, b);
    return { label, ratio, pass: ratio >= 4.5 };
  });
