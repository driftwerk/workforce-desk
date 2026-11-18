import { parse, stringify } from "smol-toml";
import { BUILTIN } from "./builtin";
import { parseTheme, serializeTheme, slug, ThemeError } from "./toml";
import {
  bestOn,
  contrast,
  contrastChecks,
  derive,
  isDarkGround,
  isHex,
  mix,
  ON_FILL_CHOICES,
  takesAlpha,
  TOKENS,
  type Corners,
  type Density,
  type Palette,
  type Theme,
  type ThemeSpec,
  type Token,
} from "./tokens";

/** A theme an agent proposed: a theme the person hasn't kept, and where it
 *  came from. Kept beside the themes as `<id>.proposal.toml`, which the
 *  chooser never lists: only Keep makes it `<id>.toml`. */
export interface Proposal {
  spec: ThemeSpec;
  /** The person's own theme it changes, when it changes one. */
  revises?: string;
  /** Who made it: the hub and agent, and the conversation it was asked in. */
  hub: string;
  agent: string;
  session?: string;
  /** What the person asked for, as the agent put it. */
  reason?: string;
  /** What Desk moved so every pair reads, in words. */
  changes: string[];
  /** The colours Desk set to do so: worked out again when a base one moves. */
  nudged: Token[];
  /** When it was made or last changed (ISO). */
  at: string;
}

/** Ids no theme of the person's may take: the built-ins', and Auto's. */
export const RESERVED_IDS: readonly string[] = [...BUILTIN.map((b) => b.id), "system"];

export const MAX_NAME = 48;

/** The base colours a proposal is given, which aren't set under `colors`. */
const BASE_TOKENS: readonly Token[] = ["bg", "signal", "text"];

/** What an agent may give `theme.propose`. */
export interface ProposeInput {
  name: string;
  dark: boolean;
  background: string;
  signal: string;
  text?: string;
  colors?: Partial<Record<Token, string>>;
  density?: Density;
  corners?: Corners;
  reason?: string;
}

/** What an agent may give `theme.revise`: the theme, and what changes. */
export interface ReviseInput {
  theme: string;
  name?: string;
  dark?: boolean;
  background?: string;
  signal?: string;
  text?: string | null;
  colors?: Partial<Record<Token, string | null>>;
  density?: Density;
  corners?: Corners;
  reason?: string;
}

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);

const DENSITIES: readonly Density[] = ["compact", "cozy"];
const CORNERS: readonly Corners[] = ["sharp", "soft", "round"];

const nameOf = (v: unknown): string => {
  if (typeof v !== "string") throw new ThemeError("`name` is the theme's name, a few words");
  // Control characters and line breaks go; spaces run together.
  const name = v.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!name) throw new ThemeError("`name` is the theme's name, a few words");
  if (name.length > MAX_NAME) throw new ThemeError(`\`name\` is ${MAX_NAME} characters at most`);
  return name;
};

const solid = (where: string, v: unknown): string => {
  if (typeof v !== "string" || !isHex(v)) throw new ThemeError(`\`${where}\` must be a colour like "#1E2A35"`);
  return v.toUpperCase();
};

const reasonOf = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ThemeError("`reason` is a sentence");
  const r = v.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return r ? r.slice(0, 280) : undefined;
};

const oneOf = <T extends string>(where: string, v: unknown, allowed: readonly T[]): T | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new ThemeError(`\`${where}\` is one of ${allowed.join(", ")}`);
};

/** The colours under `colors`, each checked: a token Desk knows, other
 *  than the base ones, a solid colour (or one with alpha where that token
 *  takes it); null, where `clear`, puts one back to what Desk works out. */
const colorsOf = (v: unknown, clear: boolean): Partial<Record<Token, string | null>> => {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) throw new ThemeError("`colors` is an object of colours by name");
  const unknown = Object.keys(v).filter((k) => !(TOKENS as readonly string[]).includes(k));
  if (unknown.length) throw new ThemeError(`Desk has no colour called ${unknown.map((k) => `"${k}"`).join(", ")}: theme.current lists them`);
  const out: Partial<Record<Token, string | null>> = {};
  for (const [k, value] of Object.entries(v)) {
    const token = k as Token;
    if (BASE_TOKENS.includes(token)) throw new ThemeError(`set "${k}" with \`${token === "bg" ? "background" : token}\`, not under \`colors\``);
    if (value === null && clear) {
      out[token] = null;
      continue;
    }
    const alpha = takesAlpha(token);
    if (typeof value !== "string" || !isHex(value, alpha))
      throw new ThemeError(`\`colors.${k}\` must be a colour like "#1E2A35"${alpha ? ' or "#00000059"' : ""}`);
    out[token] = value.toUpperCase();
  }
  return out;
};

export const parsePropose = (input: unknown): ProposeInput => {
  if (!isObject(input)) throw new ThemeError("give the theme's name, whether it is dark, and its colours");
  if (typeof input.dark !== "boolean") throw new ThemeError("`dark` is true for a dark theme, false for a light one");
  return {
    name: nameOf(input.name),
    dark: input.dark,
    background: solid("background", input.background),
    signal: solid("signal", input.signal),
    ...(input.text === undefined || input.text === null ? {} : { text: solid("text", input.text) }),
    colors: colorsOf(input.colors, false) as Partial<Record<Token, string>>,
    density: oneOf("density", input.density, DENSITIES),
    corners: oneOf("corners", input.corners, CORNERS),
    reason: reasonOf(input.reason),
  };
};

export const parseRevise = (input: unknown): ReviseInput => {
  if (!isObject(input)) throw new ThemeError("say which theme (`theme`) and what changes");
  if (typeof input.theme !== "string" || !input.theme) throw new ThemeError("`theme` is the id of the proposal or theme to change");
  if (input.dark !== undefined && typeof input.dark !== "boolean") throw new ThemeError("`dark` is true or false");
  return {
    theme: input.theme,
    ...(input.name === undefined ? {} : { name: nameOf(input.name) }),
    ...(input.dark === undefined ? {} : { dark: input.dark as boolean }),
    ...(input.background === undefined ? {} : { background: solid("background", input.background) }),
    ...(input.signal === undefined ? {} : { signal: solid("signal", input.signal) }),
    ...(input.text === undefined ? {} : { text: input.text === null ? null : solid("text", input.text) }),
    colors: colorsOf(input.colors, true),
    density: oneOf("density", input.density, DENSITIES),
    corners: oneOf("corners", input.corners, CORNERS),
    reason: reasonOf(input.reason),
  };
};

/** `name` as an id no other theme or proposal has, never a built-in's. */
export const freeId = (name: string, taken: readonly string[]): string => {
  const base = slug(name).slice(0, 40).replace(/-$/, "") || "theme";
  const used = new Set([...taken, ...RESERVED_IDS]);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
};

/** Every pair the theme is checked by: the editor's, and the terminal's
 *  colours on its ground (all but black, the ground's own end). */
export interface Check {
  label: string;
  fg: Token;
  bg: Token;
  ratio: number;
  bar: number;
  pass: boolean;
}

/** The terminal's colours checked on its ground: all but black, the
 *  ground's own end. */
const TERMINAL: readonly Token[] = [
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
];

export const allChecks = (theme: Theme): Check[] => [
  ...contrastChecks(theme).map(({ label, fg, bg, ratio, bar, pass }) => ({ label, fg, bg, ratio, bar, pass })),
  ...TERMINAL.map((t): Check => {
    const ratio = contrast(theme.colors[t], theme.colors.sunken);
    const name = t.slice(4).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return { label: `Terminal ${name}`, fg: t, bg: "sunken", ratio, bar: 4.5, pass: ratio >= 4.5 };
  }),
];

/** Text on a fill: put right by choosing the text, else by moving the fill. */
const ON_FILL: Partial<Record<Token, true>> = { onSignal: true, onBlocked: true, onMark: true, onSeriesMark: true, onApprove: true, onModeFill: true };

/** The grounds that follow the background, unless a theme sets them. */
const GROUNDS: Partial<Record<Token, true>> = { bg: true, surface: true, sunken: true, cardFill: true };

/** Text drawn on several fills (each mark, each board mark): those fills
 *  move instead. */
const SHARED_TEXT: Partial<Record<Token, true>> = { onMark: true, onSeriesMark: true };

/** `hex` moved toward `to` until it reads at `bar` on `ground`; `to` itself
 *  when nothing short of it does. */
const until = (hex: string, to: string, ground: string, bar: number): string => {
  for (let p = 0.04; p < 1; p += 0.04) {
    const next = mix(hex, to, p);
    if (contrast(next, ground) >= bar) return next;
  }
  return to;
};

/** Away from `ground`: white on a dark one, black on a light one. */
const awayFrom = (ground: string): string => (contrast("#FFFFFF", ground) >= contrast("#000000", ground) ? "#FFFFFF" : "#000000");

const said = (n: number) => `${n.toFixed(1)}:1`;

export interface Nudged {
  spec: ThemeSpec;
  /** What Desk moved, a sentence each. */
  changes: string[];
  /** The colours it set to do so. */
  nudged: Token[];
  /** How many pairs still read too faintly (none, but for a theme Desk
   *  couldn't put right). */
  low: number;
}

/** `spec` with every colour that reads too faintly moved until it reads,
 *  and what was moved, in words. The colours the agent chose are kept where
 *  they can be: a pair is put right by its text first, toward the theme's
 *  light end on a dark theme and its dark end on a light one, and only
 *  when the text can go no further does what it is drawn on move. */
export const nudge = (start: ThemeSpec, dark: boolean): Nudged => {
  let spec: ThemeSpec = { ...start, overrides: { ...start.overrides } };
  const changes: string[] = [];
  const light = dark ? "#FFFFFF" : "#000000";
  const deep = dark ? "#000000" : "#FFFFFF";
  // Dark or light, as the agent said: the background moved until Desk reads
  // it so (its rule: relative luminance under 0.2).
  if (isDarkGround(spec.background) !== dark) {
    let bg = spec.background;
    for (let p = 0.05; p <= 1 && isDarkGround(bg) !== dark; p += 0.05) bg = mix(spec.background, deep, p);
    changes.push(`The background ${spec.background} was ${dark ? "too light for a dark theme" : "too dark for a light theme"}; Desk made it ${bg}.`);
    spec = { ...spec, background: bg };
  }
  const startBackground = spec.background;
  // Each colour moved: what it was, and the first pair that moved it.
  const first = new Map<Token, { from: string; label: string; ratio: number; bar: number }>();
  const set = (token: Token, hex: string, why: Check, from: string) => {
    if (!first.has(token)) first.set(token, { from, label: why.label, ratio: why.ratio, bar: why.bar });
    spec = token === "text" ? { ...spec, text: hex } : token === "signal" ? { ...spec, signal: hex } : { ...spec, overrides: { ...spec.overrides, [token]: hex } };
  };
  let movedGround: Check | undefined;
  for (let round = 0; round < 80; round++) {
    const c = derive(spec).colors;
    const low = allChecks(derive(spec)).find((ch) => !ch.pass);
    if (!low) break;
    const { fg, bg, bar } = low;
    if (SHARED_TEXT[fg]) {
      // One text over several fills: the fill moves, so the text that reads
      // on the others still does.
      set(bg, until(c[bg], awayFrom(c[fg]), c[fg], bar), low, c[bg]);
      continue;
    }
    if (ON_FILL[fg]) {
      const best = bestOn(c[bg], ON_FILL_CHOICES);
      if (contrast(best, c[bg]) >= bar) {
        set(fg, best, low, c[fg]);
        continue;
      }
      // Neither ink nor white reads on the fill: the fill moves, away from
      // the text that reads best on it.
      set(bg, until(c[bg], awayFrom(best), best, bar), low, c[bg]);
      if (best !== c[fg]) set(fg, best, low, c[fg]);
      continue;
    }
    const toward = until(c[fg], light, c[bg], bar);
    if (contrast(toward, c[bg]) >= bar) {
      set(fg, toward, low, c[fg]);
      continue;
    }
    // As far as it goes and still short: what it is drawn on moves. The
    // panels and the terminal follow the background.
    const end = toward;
    if (end !== c[fg]) set(fg, end, low, c[fg]);
    if (GROUNDS[bg] && !(bg in spec.overrides)) {
      movedGround ??= low;
      spec = { ...spec, background: mix(spec.background, deep, 0.12) };
    } else {
      set(bg, until(c[bg], deep, end, bar), low, c[bg]);
    }
  }
  if (movedGround && spec.background !== startBackground)
    changes.push(`${movedGround.label} read ${said(movedGround.ratio)}, under ${movedGround.bar}; Desk made the background ${startBackground} → ${spec.background}.`);
  const now = derive(spec).colors;
  const nudged: Token[] = [];
  for (const [token, m] of first) {
    if (now[token] === m.from) continue;
    nudged.push(token);
    changes.push(`${m.label} read ${said(m.ratio)}, under ${m.bar}; Desk moved ${token} ${m.from} → ${now[token]}.`);
  }
  // Said, should any pair still read too faintly: never "every pair reads".
  const still = allChecks(derive(spec)).filter((c) => !c.pass);
  if (still.length) changes.push(`Still too faint: ${still.map((c) => `${c.label} (${said(c.ratio)}, under ${c.bar})`).join(", ")}.`);
  return { spec, changes, nudged, low: still.length };
};

/** A new theme from what an agent gave: every colour Desk works out from
 *  the base ones, the fonts and shape of `like` (the person's theme now). */
export const propose = (input: ProposeInput, like: ThemeSpec, taken: readonly string[]): Nudged => {
  const spec: ThemeSpec = {
    id: freeId(input.name, taken),
    name: input.name,
    background: input.background,
    signal: input.signal,
    text: input.text,
    overrides: { ...(input.colors as Partial<Palette>) },
    fonts: { ...like.fonts },
    density: input.density ?? like.density,
    corners: input.corners ?? like.corners,
  };
  return nudge(spec, input.dark);
};

/** `base` changed as an agent asked. Overrides Desk set to put a pair right
 *  are tuned to the colours they were set against, so they go when a base
 *  colour moves, and are worked out again. */
export const revise = (base: ThemeSpec, input: ReviseInput, earlier: { nudged: readonly Token[]; changes: readonly string[] } = { nudged: [], changes: [] }): Nudged => {
  const nudged = earlier.nudged;
  const moved = input.background !== undefined || input.signal !== undefined || input.text !== undefined || input.dark !== undefined;
  const overrides: Partial<Palette> = { ...base.overrides };
  if (moved) for (const t of nudged) delete overrides[t];
  for (const [k, v] of Object.entries(input.colors ?? {})) {
    if (v === null) delete overrides[k as Token];
    else overrides[k as Token] = v as string;
  }
  const spec: ThemeSpec = {
    ...base,
    name: input.name ?? base.name,
    background: input.background ?? base.background,
    signal: input.signal ?? base.signal,
    text: input.text === null ? undefined : (input.text ?? base.text),
    overrides,
    density: input.density ?? base.density,
    corners: input.corners ?? base.corners,
  };
  const made = nudge(spec, input.dark ?? isDarkGround(spec.background));
  // What Desk moved before still stands when no base colour moved: said
  // again, beside what it moved now. When one did, those were worked out
  // again, and that is said.
  const kept = moved ? [] : earlier.changes.filter((c) => !c.startsWith("Still too faint"));
  const redone = moved && nudged.length ? [`Desk worked out again the colours it had set (${nudged.join(", ")}).`] : [];
  return { ...made, changes: [...redone, ...kept, ...made.changes], nudged: [...new Set([...(moved ? [] : nudged), ...made.nudged])] };
};

const PROPOSAL = "proposal";

export const serializeProposal = (p: Proposal): string => {
  const meta: Record<string, unknown> = { hub: p.hub, agent: p.agent, at: p.at, changes: p.changes, nudged: p.nudged };
  if (p.session) meta.session = p.session;
  if (p.revises) meta.revises = p.revises;
  if (p.reason) meta.reason = p.reason;
  return `${serializeTheme(p.spec)}\n${stringify({ [PROPOSAL]: meta })}\n`;
};

const strOf = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export const parseProposal = (id: string, source: string): Proposal => {
  const spec = parseTheme(id, source);
  let meta: Raw = {};
  try {
    const doc = parse(source) as Raw;
    meta = isObject(doc[PROPOSAL]) ? doc[PROPOSAL] : {};
  } catch (e) {
    throw new ThemeError(`not valid TOML: ${(e as Error).message}`);
  }
  const revises = strOf(meta.revises);
  const session = strOf(meta.session);
  const reason = strOf(meta.reason);
  return {
    spec,
    hub: strOf(meta.hub) ?? "",
    agent: strOf(meta.agent) ?? "",
    at: strOf(meta.at) ?? new Date(0).toISOString(),
    changes: Array.isArray(meta.changes) ? meta.changes.filter((c): c is string => typeof c === "string") : [],
    nudged: Array.isArray(meta.nudged) ? meta.nudged.filter((t): t is Token => (TOKENS as readonly unknown[]).includes(t)) : [],
    ...(revises ? { revises } : {}),
    ...(session ? { session } : {}),
    ...(reason ? { reason } : {}),
  };
};
