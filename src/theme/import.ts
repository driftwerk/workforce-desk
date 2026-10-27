import { formatHex, parse } from "culori";
import { DAY, NIGHT } from "./builtin";
import { ThemeError, parseTheme, slug } from "./toml";
import { contrast, derive, luminance, mix, type Palette, type ThemeSpec } from "./tokens";

export type ThemeFormat = "vscode" | "ghostty" | "iterm" | "base16" | "desk";

export const FORMAT_NAMES: Record<ThemeFormat, string> = {
  vscode: "VS Code",
  ghostty: "Ghostty",
  iterm: "iTerm2",
  base16: "base16",
  desk: "Desk",
};

type Terminal = "ansiRed" | "ansiGreen" | "ansiCyan" | "termText";

interface Found {
  name?: string;
  background?: string;
  text?: string;
  accents: (string | undefined)[];
  terminal: Partial<Record<Terminal, string>>;
}

const BY_EXTENSION: Record<string, ThemeFormat> = {
  json: "vscode",
  jsonc: "vscode",
  itermcolors: "iterm",
  yaml: "base16",
  yml: "base16",
  toml: "desk",
  ghostty: "ghostty",
};

const baseName = (fileName: string): string => fileName.split(/[\\/]/).pop() ?? fileName;

const stem = (fileName: string): string => baseName(fileName).replace(/\.[^.]+$/, "").trim() || "Imported";

const extension = (fileName: string): string | undefined => /\.([a-z0-9]+)$/i.exec(baseName(fileName))?.[1]?.toLowerCase();

export const detectFormat = (fileName: string, source: string): ThemeFormat => {
  const ext = extension(fileName);
  const known = ext ? BY_EXTENSION[ext] : undefined;
  if (known) return known;
  const head = source.trimStart();
  if (head.startsWith("<?xml") || /<plist[\s>]/.test(head)) return "iterm";
  if (head.startsWith("{")) return "vscode";
  if (/^\s*base0[0-9a-f]\s*:/im.test(source)) return "base16";
  if (/^\s*\[colors\]/m.test(source)) return "desk";
  if (/^\s*(background|foreground|palette)\s*=/m.test(source)) return "ghostty";
  throw new ThemeError(
    `Desk can't tell what kind of theme ${baseName(fileName)} is. It reads VS Code (.json), Ghostty, iTerm2 (.itermcolors) and base16 (.yaml) themes.`,
  );
};

const solid = (raw: string | undefined, over?: string): string | undefined => {
  const value = raw?.trim();
  if (!value) return undefined;
  const parsed = parse(/^[0-9a-f]{3,8}$/i.test(value) ? `#${value}` : value);
  if (!parsed) return undefined;
  const hex = formatHex(parsed)?.toUpperCase();
  if (!hex) return undefined;
  const alpha = parsed.alpha ?? 1;
  return over && alpha < 1 ? mix(over, hex, alpha) : hex;
};

const isDark = (bg: string): boolean => luminance(bg) < 0.2;

const onSignalOf = (spec: ThemeSpec, signal: string): string => derive({ ...spec, signal }).colors.onSignal;

const usableSignal = (spec: ThemeSpec, c: string): boolean =>
  contrast(c, spec.background) >= 3 && contrast(onSignalOf(spec, c), c) >= 4.5;

const nudged = (spec: ThemeSpec, c: string): string | undefined => {
  const toward = isDark(spec.background) ? "#FFFFFF" : "#000000";
  for (let p = 0.1; p < 1; p += 0.1) {
    const next = mix(c, toward, p);
    if (usableSignal(spec, next)) return next;
  }
  return undefined;
};

const chroma = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  return Math.max(r, g, b) - Math.min(r, g, b);
};

/** The first accent that reads on the background and carries button text;
 *  otherwise the most colourful accent lightened or darkened until it does. */
export const pickSignal = (spec: ThemeSpec, accents: readonly string[]): string => {
  const text = derive(spec).colors.text;
  const distinct = accents.filter((c) => contrast(c, text) >= 1.2);
  const ready = distinct.find((c) => usableSignal(spec, c));
  if (ready) return ready;
  for (const c of [...distinct].sort((a, b) => chroma(b) - chroma(a))) {
    const fixed = nudged(spec, c);
    if (fixed) return fixed;
  }
  return isDark(spec.background) ? NIGHT.signal : DAY.signal;
};

const assemble = (format: ThemeFormat, fallbackName: string, found: Found): ThemeSpec => {
  const background = solid(found.background);
  if (!background) {
    throw new ThemeError(
      found.background
        ? `the ${FORMAT_NAMES[format]} theme's background "${found.background}" is not a colour`
        : `the ${FORMAT_NAMES[format]} theme has no background colour`,
    );
  }
  const name = found.name?.trim() || fallbackName;
  const base: ThemeSpec = {
    id: slug(name),
    name,
    background,
    signal: background,
    text: solid(found.text, background),
    overrides: {},
    fonts: { ...NIGHT.fonts },
    density: NIGHT.density,
    corners: NIGHT.corners,
  };
  const accents = found.accents.flatMap((c) => solid(c, background) ?? []);
  const signal = pickSignal(base, accents);
  const terminalBg = derive({ ...base, signal }).colors.sunken;
  const overrides: Partial<Palette> = {};
  for (const [token, raw] of Object.entries(found.terminal) as [Terminal, string][]) {
    const c = solid(raw, terminalBg);
    if (c && contrast(c, terminalBg) >= 3) overrides[token] = c;
  }
  return { ...base, signal, overrides };
};

const stripJsonc = (source: string): string => {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return dropTrailingCommas(out);
};

const dropTrailingCommas = (json: string): string => {
  const closes = /\s*[}\]]/y;
  let out = "";
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      out += json.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === ",") {
      closes.lastIndex = i + 1;
      if (closes.test(json)) continue;
    }
    out += ch;
  }
  return out;
};

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export const importVsCode = (fileName: string, source: string): ThemeSpec => {
  let doc: unknown;
  try {
    doc = JSON.parse(stripJsonc(source));
  } catch (e) {
    throw new ThemeError(`${baseName(fileName)} is not valid JSON: ${(e as Error).message}`);
  }
  const root = doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  const colors = root.colors && typeof root.colors === "object" ? (root.colors as Record<string, unknown>) : undefined;
  if (!colors) throw new ThemeError(`${baseName(fileName)} has no "colors", so it is not a VS Code colour theme`);
  const c = (key: string) => text(colors[key]);
  if (!c("editor.background")) throw new ThemeError(`the VS Code theme has no "editor.background" colour`);
  return assemble("vscode", stem(fileName), {
    name: text(root.name),
    background: c("editor.background"),
    text: c("editor.foreground") ?? c("foreground"),
    accents: [c("focusBorder"), c("button.background"), c("activityBarBadge.background"), c("textLink.foreground")],
    terminal: {
      ansiRed: c("terminal.ansiRed"),
      ansiGreen: c("terminal.ansiGreen"),
      ansiCyan: c("terminal.ansiCyan"),
      termText: c("terminal.foreground"),
    },
  });
};

const unquote = (raw: string): string => {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    return end < 0 ? v.slice(1) : v.slice(1, end);
  }
  return v;
};

export const importGhostty = (fileName: string, source: string): ThemeSpec => {
  const keys: Record<string, string> = {};
  const palette: Record<number, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const value = unquote(t.slice(eq + 1));
    const entry = key === "palette" ? /^(\d+)\s*=\s*(.+)$/.exec(value) : null;
    if (entry) palette[Number(entry[1])] = entry[2]!.trim();
    else keys[key] = value;
  }
  if (!keys.background) throw new ThemeError("the Ghostty config has no `background = ` line");
  return assemble("ghostty", stem(fileName), {
    background: keys.background,
    text: keys.foreground,
    accents: [keys["cursor-color"], palette[4], palette[5], palette[12], palette[13], palette[6], palette[2], palette[3]],
    terminal: { ansiRed: palette[1], ansiGreen: palette[2], ansiCyan: palette[6] },
  });
};

const plistPairs = (dict: Element): Map<string, Element> => {
  const pairs = new Map<string, Element>();
  const children = Array.from(dict.children);
  children.forEach((child, i) => {
    const value = children[i + 1];
    if (child.tagName === "key" && value) pairs.set(child.textContent?.trim() ?? "", value);
  });
  return pairs;
};

const plistColour = (value: Element | undefined): string | undefined => {
  if (value?.tagName !== "dict") return undefined;
  const parts = plistPairs(value);
  const channel = (name: string) => {
    const el = parts.get(`${name} Component`);
    const n = el && (el.tagName === "real" || el.tagName === "integer") ? Number(el.textContent) : NaN;
    return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(1, n)) * 255) : undefined;
  };
  const rgb = [channel("Red"), channel("Green"), channel("Blue")];
  if (rgb.some((v) => v === undefined)) return undefined;
  return "#" + rgb.map((v) => v!.toString(16).padStart(2, "0")).join("").toUpperCase();
};

export const importITerm = (fileName: string, source: string): ThemeSpec => {
  const doc = new DOMParser().parseFromString(source, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new ThemeError(`${baseName(fileName)} is not a valid plist`);
  const dict = Array.from(doc.documentElement.children).find((el) => el.tagName === "dict");
  if (doc.documentElement.tagName !== "plist" || !dict) throw new ThemeError(`${baseName(fileName)} is not an iTerm2 colour preset`);
  const entries = plistPairs(dict);
  const colour = (key: string) => plistColour(entries.get(key));
  const ansi = (n: number) => colour(`Ansi ${n} Color`);
  if (!colour("Background Color")) throw new ThemeError(`the iTerm2 preset has no "Background Color"`);
  return assemble("iterm", stem(fileName), {
    background: colour("Background Color"),
    text: colour("Foreground Color"),
    accents: [colour("Cursor Color"), ansi(4), ansi(5), ansi(12), ansi(13), ansi(6), ansi(2), ansi(3)],
    terminal: { ansiRed: ansi(1), ansiGreen: ansi(2), ansiCyan: ansi(6) },
  });
};

export const importBase16 = (fileName: string, source: string): ThemeSpec => {
  const fields: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2]!;
    const value = /^["']/.test(raw.trim()) ? unquote(raw) : raw.replace(/\s+#.*$/, "").trim();
    if (value) fields[m[1]!.toLowerCase()] = value;
  }
  if (!fields.base00) throw new ThemeError("the base16 scheme has no base00 colour");
  return assemble("base16", stem(fileName), {
    name: fields.scheme ?? fields.name,
    background: fields.base00,
    text: fields.base05,
    accents: [fields.base0d, fields.base0e, fields.base0c, fields.base0b, fields.base09, fields.base0a],
    terminal: { ansiRed: fields.base08, ansiGreen: fields.base0b, ansiCyan: fields.base0c },
  });
};

const IMPORTERS: Record<ThemeFormat, (fileName: string, source: string) => ThemeSpec> = {
  vscode: importVsCode,
  ghostty: importGhostty,
  iterm: importITerm,
  base16: importBase16,
  desk: (fileName, source) => parseTheme(slug(stem(fileName)), source),
};

/** Reads any theme Desk understands into a theme spec. The id is the name's
 *  slug; the caller makes it unique. */
export const importTheme = (fileName: string, source: string): ThemeSpec =>
  IMPORTERS[detectFormat(fileName, source)](fileName, source);
