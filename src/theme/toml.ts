import { parse, stringify } from "smol-toml";
import { BUILTIN } from "./builtin";
import { SIZE_RANGES, TOKENS, isHex, type Corners, type Density, type Palette, type SizeRole, type ThemeSpec, type Token } from "./tokens";

export class ThemeError extends Error {}

const DEFAULTS = BUILTIN[0]!;
const DENSITIES: readonly Density[] = ["compact", "cozy"];
const CORNERS: readonly Corners[] = ["sharp", "soft", "round"];

type Table = Record<string, unknown>;

const table = (v: unknown): Table => (v && typeof v === "object" && !Array.isArray(v) ? (v as Table) : {});

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const color = (where: string, v: unknown): string => {
  const s = str(v);
  if (!s || !isHex(s)) throw new ThemeError(`${where} must be a colour like "#112233"`);
  return s.toUpperCase();
};

const oneOf = <T extends string>(where: string, v: unknown, allowed: readonly T[], fallback: T): T => {
  if (v === undefined) return fallback;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new ThemeError(`${where} must be one of ${allowed.join(", ")}`);
};

const isToken = (k: string): k is Token => (TOKENS as readonly string[]).includes(k);

/** Each size's key under `[type]`. */
const SIZE_KEYS: Record<SizeRole, string> = { size: "size", chatSize: "chat_size", codeSize: "code_size" };

const sizeOf = (type: Table, role: SizeRole): number | undefined => {
  const v = type[SIZE_KEYS[role]];
  const [min, max] = SIZE_RANGES[role];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || v < min || v > max) throw new ThemeError(`[type].${SIZE_KEYS[role]} must be a number from ${min} to ${max}`);
  return v;
};

export const parseTheme = (id: string, source: string): ThemeSpec => {
  let doc: Table;
  try {
    doc = parse(source) as Table;
  } catch (e) {
    throw new ThemeError(`not valid TOML: ${(e as Error).message}`);
  }
  const colors = table(doc.colors);
  const type = table(doc.type);
  const shape = table(doc.shape);
  const overrides: Partial<Palette> = {};
  for (const [k, v] of Object.entries(table(colors.override))) {
    if (!isToken(k)) throw new ThemeError(`[colors.override] has unknown colour "${k}"`);
    overrides[k] = color(`[colors.override].${k}`, v);
  }
  // A theme from before chats and code had sizes of their own looks as it
  // did: its chats at its one size, its code at Desk's.
  const size = sizeOf(type, "size") ?? DEFAULTS.fonts.size;
  return {
    id,
    name: str(doc.name) ?? id,
    background: color("[colors].background", colors.background),
    signal: color("[colors].signal", colors.signal),
    text: colors.text === undefined ? undefined : color("[colors].text", colors.text),
    overrides,
    fonts: {
      display: str(type.display) ?? DEFAULTS.fonts.display,
      ui: str(type.ui) ?? DEFAULTS.fonts.ui,
      mono: str(type.mono) ?? DEFAULTS.fonts.mono,
      size,
      chatSize: sizeOf(type, "chatSize") ?? size,
      codeSize: sizeOf(type, "codeSize") ?? DEFAULTS.fonts.codeSize,
    },
    density: oneOf("[shape].density", shape.density, DENSITIES, "cozy"),
    corners: oneOf("[shape].corners", shape.corners, CORNERS, "soft"),
  };
};

export const serializeTheme = (spec: ThemeSpec): string => {
  const colors: Table = { background: spec.background, signal: spec.signal };
  if (spec.text) colors.text = spec.text;
  if (Object.keys(spec.overrides).length) colors.override = spec.overrides;
  return (
    stringify({
      name: spec.name,
      colors,
      type: {
        display: spec.fonts.display,
        ui: spec.fonts.ui,
        mono: spec.fonts.mono,
        ...Object.fromEntries((Object.keys(SIZE_KEYS) as SizeRole[]).map((role) => [SIZE_KEYS[role], spec.fonts[role]])),
      },
      shape: { density: spec.density, corners: spec.corners },
    }) + "\n"
  );
};

export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "theme";
