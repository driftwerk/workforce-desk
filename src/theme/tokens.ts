import { clampChroma, formatHex, oklch } from "culori";

/** Every colour a theme has. Each can be overridden under
 *  `[colors.override]` in a theme's TOML; those not set are derived from
 *  the background, signal and text (see `derive`):
 *  - the terminal's: its ground is `sunken`, its text `termText`, its
 *    cursor `termCursor`, selection `termSelection`, and the 16 ANSI
 *    colours `ansiBlack`…`ansiWhite` and `ansiBrightBlack`…`ansiBrightWhite`
 *    (the bright ones follow their plain colour unless set). The programs
 *    in a terminal are told these when they ask (OSC 4, 10 and 11).
 *  - `handle`: drag handles at rest (a column's resize grip, the edges
 *    between grid panes) — the border colour unless set.
 *  - `handleActive`: a drag handle hovered, dragged or focused — the
 *    signal colour unless set.
 *  - `diffAdd`, `diffDel`: the grounds of added and removed lines.
 *  - `shadow`: what menus, dialogs and popovers cast; `lift`: the soft
 *    shadow under cards, buttons and a selected pill; `edge`: the hairline
 *    round a selected pill or row and a mark. These three may carry alpha
 *    (`#RRGGBBAA`); lift and edge are transparent unless set.
 *  - `logoDot`: the wordmark's dot, the signal unless set.
 *  - `onMark`: the initials on a mark; `mark1`…`mark6`: the marks' colours
 *    (an engine's is `mark6`).
 *  - `series1`…`series8`: a chart's series, slot by slot.
 *  Failed states are drawn in `ansiRed`, the terminal's red, so setting one
 *  sets the other. */
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
  "termCursor",
  "termSelection",
  "ansiBlack",
  "ansiRed",
  "ansiGreen",
  "ansiYellow",
  "ansiBlue",
  "ansiMagenta",
  "ansiCyan",
  "ansiWhite",
  "ansiBrightBlack",
  "ansiBrightRed",
  "ansiBrightGreen",
  "ansiBrightYellow",
  "ansiBrightBlue",
  "ansiBrightMagenta",
  "ansiBrightCyan",
  "ansiBrightWhite",
  "handle",
  "handleActive",
  "diffAdd",
  "diffDel",
  "shadow",
  "edge",
  "lift",
  "logoDot",
  "onMark",
  "mark1",
  "mark2",
  "mark3",
  "mark4",
  "mark5",
  "mark6",
  "series1",
  "series2",
  "series3",
  "series4",
  "series5",
  "series6",
  "series7",
  "series8",
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
const HEX_ALPHA = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The colours that may carry alpha (`#RRGGBBAA`): shadows and hairlines
 *  drawn over whatever is under them. Every other colour is solid. */
export const ALPHA_TOKENS: readonly Token[] = ["shadow", "edge", "lift"];

export const takesAlpha = (token: string): boolean => (ALPHA_TOKENS as readonly string[]).includes(token);

/** A colour like `#112233`, or `#11223344` where `alpha` allows it. */
export const isHex = (value: string, alpha = false): boolean => (alpha ? HEX_ALPHA : HEX).test(value);

/** `hex` with its alpha scaled by `k` (a solid colour's alpha is 1). */
export const scaleAlpha = (hex: string, k: number): string => {
  const a = hex.length === 9 ? parseInt(hex.slice(7), 16) : 255;
  const scaled = Math.round(Math.max(0, Math.min(255, a * k)));
  return `${hex.slice(0, 7)}${scaled.toString(16).padStart(2, "0")}`.toUpperCase();
};

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

/** Of `options`, the one that reads best on `ground` (WCAG contrast). */
export const bestOn = (ground: string, options: readonly string[]): string =>
  options.reduce((best, o) => (contrast(o, ground) > contrast(best, ground) ? o : best));

/** Whether `bg` is a dark ground: light text reads better on it than dark
 *  text does. */
export const isDarkGround = (bg: string): boolean => bestOn(bg, [INK, PAPER_TEXT]) === PAPER_TEXT;

/** The status and terminal colours as Desk draws them on its own text:
 *  near-white on a dark background, ink on a light one. */
const TONES = {
  working: ["#7DB8FF", "#1D5FD1"],
  blocked: ["#FFB547", "#A85A00"],
  done: ["#6EE7A8", "#17803F"],
  ansiRed: ["#FF8A7A", "#B42318"],
  ansiGreen: ["#A6E37A", "#3F7A12"],
  ansiCyan: ["#8FD8E8", "#0E7490"],
  ansiMagenta: ["#C9B8FF", "#7240C4"],
} as const;

type Tone = keyof typeof TONES;

/** The least a status colour has, against every ground it is drawn on:
 *  each is text somewhere (a state's label, code in a reply). */
const STATE_CONTRAST = 4.5;

/** Desk's colour `tone` on a theme whose text is `text`: the same hue, as
 *  far from the background, relative to that text, as Desk's is from its
 *  own (so grey text dims it as much), and a little more saturated than that
 *  alone would leave it, then moved away from the background until it reads
 *  on each of the grounds it would be drawn on. On Desk's own text it is
 *  Desk's colour. */
const toned = (tone: string, dark: boolean, text: string, grounds: (hex: string) => readonly string[]): string => {
  const reads = (hex: string) => Math.min(...grounds(hex).map((g) => contrast(hex, g))) >= STATE_CONTRAST;
  if (text === (dark ? PAPER_TEXT : INK) && reads(tone)) return tone;
  const own = oklch(tone)!;
  const t = oklch(text)!.l;
  const ref = oklch(dark ? PAPER_TEXT : INK)!.l;
  // How far the text is from the background's end of the scale, against Desk's.
  const k = dark ? t / ref : (1 - t) / (1 - ref);
  const at = (l: number) => formatHex(clampChroma({ ...own, l, c: own.c * Math.sqrt(k) }, "oklch")).toUpperCase();
  const l = dark ? own.l * k : 1 - (1 - own.l) * k;
  for (let step = 0; step <= 50; step++) {
    const next = Math.max(0, Math.min(1, l + (dark ? step : -step) * 0.01));
    if (reads(at(next)) || next === 0 || next === 1) return at(next);
  }
  return at(l);
};

export const derive = (spec: ThemeSpec): Theme => {
  const bg = spec.background;
  const dark = isDarkGround(bg);
  const text = spec.text ?? (dark ? PAPER_TEXT : INK);
  const signal = spec.signal;
  const signalSoft = mix(signal, bg, 0.78);
  const surface = mix(bg, text, 0.04);
  const raised = mix(bg, text, 0.08);
  const sunken = dark ? mix(bg, "#000000", 0.3) : mix(bg, "#FFFFFF", 0.6);
  // Where they are drawn: on the panels, and in code on the sunken ground.
  const grounds = [bg, surface, sunken];
  // The states and terminal colours follow the text as it ends up, an
  // overridden one included.
  const ink = spec.overrides.text ?? text;
  const tone = (t: Tone, on: (hex: string) => readonly string[] = () => grounds) => toned(TONES[t][dark ? 0 : 1], dark, ink, on);
  // Blocked is also drawn on its soft ground, a tint of it on a dark theme.
  const softOf = (b: string) => (dark ? mix(bg, b, 0.12) : mix(bg, "#FFB547", 0.16));
  const blocked = tone("blocked", (b) => [...grounds, softOf(b)]);
  const blockedSoft = softOf(blocked);
  // Text on a blocked fill: Desk's, unless the other reads better on it.
  const [on, otherOn] = dark ? ["#2B1B03", "#FFFFFF"] : ["#FFFFFF", "#2B1B03"];
  const onBlocked = contrast(on, blocked) >= STATE_CONTRAST || contrast(on, blocked) >= contrast(otherOn, blocked) ? on : otherOn;
  const derived: Omit<Palette, Follower | Surround> = {
    bg,
    surface,
    raised,
    sunken,
    border: mix(bg, text, 0.16),
    text,
    muted: mix(text, bg, 0.28),
    faint: mix(text, bg, 0.42),
    signal,
    onSignal: bestOn(signal, [INK, "#FFFFFF"]),
    signalSoft,
    signalSoftText:
      contrast(signal, signalSoft) >= 4.5 ? signal : dark ? mix(signal, "#FFFFFF", 0.45) : mix(signal, "#000000", 0.55),
    working: tone("working"),
    blocked,
    onBlocked,
    blockedSoft,
    done: tone("done"),
    idle: mix(text, bg, 0.5),
    termText: mix(text, bg, 0.12),
    ansiRed: tone("ansiRed"),
    ansiGreen: tone("ansiGreen"),
    ansiCyan: tone("ansiCyan"),
    ansiMagenta: tone("ansiMagenta"),
  };
  const colors = { ...derived, ...spec.overrides };
  // The handles and the rest of the terminal follow the colours as they end
  // up, overrides included, unless a theme sets them itself.
  return { spec, dark, colors: { ...colors, ...followers(colors), ...surround(colors, dark), ...spec.overrides } };
};

/** The colours of what surrounds the panels — depth, diffs, the logo,
 *  marks and charts — unless a theme sets them: what Desk drew before they
 *  were tokens, so a theme that leaves them out looks as it did. */
type Surround =
  | "diffAdd"
  | "diffDel"
  | "shadow"
  | "edge"
  | "lift"
  | "logoDot"
  | "onMark"
  | "mark1"
  | "mark2"
  | "mark3"
  | "mark4"
  | "mark5"
  | "mark6"
  | "series1"
  | "series2"
  | "series3"
  | "series4"
  | "series5"
  | "series6"
  | "series7"
  | "series8";

const TRANSPARENT = "#00000000";

/** Marks' colours: pastels, read with `onMark` ink on them. */
const MARKS = ["#C9B8FF", "#FFC98A", "#A8D8FF", "#A6EBC9", "#FFB3C7", "#E8DDB5"] as const;

/** A chart's series, slot by slot: one categorical palette, validated for
 *  colour-vision deficiency, stepped for a light ground or a dark one. Its
 *  slot order keeps neighbours apart, so a theme changes the steps and never
 *  the order. */
const SERIES_LIGHT = ["#2A78D6", "#EB6834", "#1BAF7A", "#EDA100", "#E87BA4", "#008300", "#6250D6", "#E34948"] as const;
const SERIES_DARK = ["#3987E5", "#D95926", "#199E70", "#C98500", "#D55181", "#008300", "#9085E9", "#E66767"] as const;

const surround = (c: Omit<Palette, Follower | Surround> & Partial<Palette>, dark: boolean): Record<Surround, string> => {
  const series = dark ? SERIES_DARK : SERIES_LIGHT;
  return {
    diffAdd: mix(c.sunken, c.ansiGreen, 0.14),
    diffDel: mix(c.sunken, c.ansiRed, 0.14),
    shadow: "#00000059",
    edge: TRANSPARENT,
    lift: TRANSPARENT,
    logoDot: c.signal,
    onMark: INK,
    ...(Object.fromEntries(MARKS.map((m, i) => [`mark${i + 1}`, m])) as Record<`mark${1 | 2 | 3 | 4 | 5 | 6}`, string>),
    ...(Object.fromEntries(series.map((s, i) => [`series${i + 1}`, s])) as Record<`series${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`, string>),
  };
};

/** The colours that follow others unless a theme sets them. */
type Follower =
  | "handle"
  | "handleActive"
  | "termCursor"
  | "termSelection"
  | "ansiBlack"
  | "ansiYellow"
  | "ansiBlue"
  | "ansiWhite"
  | "ansiBrightBlack"
  | "ansiBrightRed"
  | "ansiBrightGreen"
  | "ansiBrightYellow"
  | "ansiBrightBlue"
  | "ansiBrightMagenta"
  | "ansiBrightCyan"
  | "ansiBrightWhite";

const followers = (c: Omit<Palette, Follower | Surround> & Partial<Palette>): Record<Follower, string> => {
  const yellow = c.ansiYellow ?? c.blocked;
  const blue = c.ansiBlue ?? c.working;
  // The terminal's own ground, light or dark as `terminalLight` (xterm.ts)
  // has it: a theme's terminal may be dark in a light theme, or the other way.
  const light = luminance(c.sunken) >= 0.2;
  // A derived colour is moved toward the terminal's text until it reads on
  // the ground; one that reads is as it is. Text that doesn't read there
  // itself gives way to black or white.
  const toward = contrast(c.termText, c.sunken) >= STATE_CONTRAST ? c.termText : light ? "#000000" : "#FFFFFF";
  const reads = (hex: string): string => {
    for (let p = 0; p <= 1; p += 0.05) {
      const next = mix(hex, toward, p);
      if (contrast(next, c.sunken) >= STATE_CONTRAST) return next;
    }
    return toward;
  };
  // A bright colour is its plain one a quarter of the way to the text.
  const bright = (plain: string) => reads(mix(plain, c.text, 0.25));
  return {
    handle: c.border,
    handleActive: c.signal,
    termCursor: c.signal,
    termSelection: mix(c.sunken, c.signal, 0.28),
    // Black is the ground's end on a dark terminal, the text's on a light one.
    ansiBlack: light ? c.text : mix(c.sunken, c.text, 0.18),
    ansiYellow: yellow,
    ansiBlue: blue,
    ansiWhite: reads(light ? mix(c.text, c.bg, 0.4) : c.termText),
    ansiBrightBlack: reads(c.faint),
    ansiBrightRed: bright(c.ansiRed),
    ansiBrightGreen: bright(c.ansiGreen),
    ansiBrightYellow: bright(yellow),
    ansiBrightBlue: bright(blue),
    ansiBrightMagenta: bright(c.ansiMagenta),
    ansiBrightCyan: bright(c.ansiCyan),
    ansiBrightWhite: reads(c.text),
  };
};

const kebab = (token: string): string => token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export const RADII: Record<Corners, number> = { sharp: 4, soft: 14, round: 22 };

/** The colour emoji fonts of macOS, Windows and Linux, which end every
 *  stack: most fonts a theme can pick have no emoji, and some draw a few
 *  (❤, ☺) in black and white. */
export const EMOJI_STACK = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';

/** The CSS font stack code and terminals are drawn in. */
export const monoStack = (spec: ThemeSpec): string => `"${spec.fonts.mono}", ui-monospace, monospace, ${EMOJI_STACK}`;

/** The stack the interface and headings are drawn in. */
const textStack = (font: string): string => `"${font}", system-ui, sans-serif, ${EMOJI_STACK}`;

export const cssVariables = (theme: Theme): Record<string, string> => {
  const { colors, spec } = theme;
  const r = RADII[spec.corners];
  return {
    ...Object.fromEntries(TOKENS.map((t) => [`--${kebab(t)}`, colors[t]])),
    "--font-display": textStack(spec.fonts.display),
    "--font-ui": textStack(spec.fonts.ui),
    "--font-mono": monoStack(spec),
    "--font-emoji": EMOJI_STACK,
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
    // The lighter and heavier shadows: today's .25 and .4 beside the .35
    // `shadow` is, in its own colour.
    "--shadow-soft": scaleAlpha(colors.shadow, 0.25 / 0.35),
    "--shadow-strong": scaleAlpha(colors.shadow, 0.4 / 0.35),
    ...Object.fromEntries(chartSeries(colors).map((c, i) => [`--rich-series-${i + 1}`, c])),
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

/** A chart's series colours, slot by slot. */
export const chartSeries = (c: Palette): readonly string[] => [c.series1, c.series2, c.series3, c.series4, c.series5, c.series6, c.series7, c.series8];

/** The mark tokens, in the order names are spread over them. */
export const MARK_TOKENS = ["mark1", "mark2", "mark3", "mark4", "mark5", "mark6"] as const satisfies readonly Token[];

/** An engine's mark (Claude Code's, Codex's). */
export const ENGINE_MARK: Token = "mark6";

/** The mark token `name` is drawn in: the same one for a name every time. */
export const markFor = (name: string): Token => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return MARK_TOKENS[h % MARK_TOKENS.length] ?? MARK_TOKENS[0];
};

/** A token as the CSS variable it is set as. */
export const tokenVar = (token: Token): string => `var(--${kebab(token)})`;

export interface ContrastCheck {
  label: string;
  ratio: number;
  /** The least it should be: 4.5 for text, 3 for marks that aren't text. */
  bar: number;
  pass: boolean;
}

/** Text (WCAG AA) and what isn't text but must be seen (dots, focus rings). */
export const TEXT_CONTRAST = 4.5;
export const MARK_CONTRAST = 3;

/** Every pair of colours Desk draws one on the other where it has to be
 *  read, with its bar. */
export const contrastPairs = (c: Palette): [label: string, fg: string, bg: string, bar: number][] => [
  ["Text on background", c.text, c.bg, TEXT_CONTRAST],
  ["Text on panels", c.text, c.surface, TEXT_CONTRAST],
  ["Text on the terminal", c.text, c.sunken, TEXT_CONTRAST],
  ["Secondary text on background", c.muted, c.bg, TEXT_CONTRAST],
  ["Secondary text on panels", c.muted, c.surface, TEXT_CONTRAST],
  ["Secondary text on the terminal", c.muted, c.sunken, TEXT_CONTRAST],
  ["Labels and timestamps", c.faint, c.bg, TEXT_CONTRAST],
  ["Labels on panels", c.faint, c.surface, TEXT_CONTRAST],
  ["Labels on the terminal", c.faint, c.sunken, TEXT_CONTRAST],
  ["Signal as text", c.signal, c.bg, TEXT_CONTRAST],
  ["Button text on signal", c.onSignal, c.signal, TEXT_CONTRAST],
  ["Text on the soft tint", c.signalSoftText, c.signalSoft, TEXT_CONTRAST],
  ["Working on panels", c.working, c.surface, TEXT_CONTRAST],
  ["Working on the terminal", c.working, c.sunken, TEXT_CONTRAST],
  ["Needs you on panels", c.blocked, c.surface, TEXT_CONTRAST],
  ["Needs you on its card", c.blocked, c.blockedSoft, TEXT_CONTRAST],
  ["Text on a needs-you button", c.onBlocked, c.blocked, TEXT_CONTRAST],
  ["Done on panels", c.done, c.surface, TEXT_CONTRAST],
  ["Done on the terminal", c.done, c.sunken, TEXT_CONTRAST],
  ["Terminal text", c.termText, c.sunken, TEXT_CONTRAST],
  ...MARK_TOKENS.map((m, i) => [`Initials on mark ${i + 1}`, c.onMark, c[m], TEXT_CONTRAST] as [string, string, string, number]),
  ["Idle dot on panels", c.idle, c.surface, MARK_CONTRAST],
  ["Focus ring on background", c.signal, c.bg, MARK_CONTRAST],
];

/** How each pair reads: shown in the theme editor, where a low one says so. */
export const contrastChecks = ({ colors }: Theme): ContrastCheck[] =>
  contrastPairs(colors).map(([label, a, b, bar]) => {
    const ratio = contrast(a, b);
    return { label, ratio, bar, pass: ratio >= bar };
  });
