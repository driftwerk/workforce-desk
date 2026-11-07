import { describe, expect, it } from "vitest";
import { BUILTIN } from "./theme/builtin";
import { cssVariables, derive } from "./theme/tokens";
import { dimVariables } from "./theme/xterm";

// Every colour Desk draws comes from a theme token, which the theme editor and
// a theme's file can set. This fails on a colour written into the styles or
// the components instead. The theme's own files (tokens and their defaults,
// the built-in themes, import and the terminal's palette) are where colours
// belong.

/** Desk's styles and components, by their path under src/: all but the
 *  theme's colour files, the test helpers and the tests. */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(
      ["./**/*.{css,ts,tsx}", "!./theme/tokens.ts", "!./theme/builtin.ts", "!./theme/import.ts", "!./theme/xterm.ts", "!./testing/**", "!./**/*.test.{ts,tsx}", "!./**/*.d.ts"],
      { query: "?raw", import: "default", eager: true },
    ),
  ).map(([path, source]) => [path.replace(/^\.\//, ""), source]),
);

/** Colours written in on purpose, each with why. A snippet no longer found
 *  fails too, so the list stays true. */
const ALLOWED: { file: string; snippet: string; why: string }[] = [
  { file: "styles/app.css", snippet: "linear-gradient(#000 0 0) content-box", why: "a mask's shape; its colour is never drawn" },
  { file: "styles/app.css", snippet: "linear-gradient(#000 0 0);", why: "a mask's shape; its colour is never drawn" },
  { file: "emoji/data.ts", snippet: 'pixels("#00f")', why: "a probe drawn off screen to tell colour emoji from text" },
  { file: "emoji/data.ts", snippet: 'pixels("#f00")', why: "a probe drawn off screen to tell colour emoji from text" },
  { file: "theme/toml.ts", snippet: 'like "#112233"', why: "an example in an error message" },
  { file: "theme/toml.ts", snippet: 'or "#11223344"', why: "an example in an error message" },
  ...["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"].map((n) => ({
    file: "settings/editing.ts",
    snippet: `["ansi${n}", "${n.toLowerCase()}"]`,
    why: "the editor's label for a terminal colour, not a colour",
  })),
  { file: "settings/voiceCatalog.ts", snippet: 'id: "coral", name: "Coral"', why: "a voice's name" },
  ...["#111210", "#0E1822", "#1A1423", "#FBFAF7", "#F6F6F1", "#FFFFFF", "#EEF2F6", "#D4FF3A", "#FF9F6B", "#7DD3FC", "#C4B5FD", "#FF6B9A", "#161714", "#3F5A06", "#1F5FBF", "#B4440F", "#5B45C9", "#B02A5B", "#1B1C18"].map(
    (hex) => ({ file: "settings/editing.ts", snippet: `hex: "${hex}"`, why: "the editor's swatches: colours offered to set a theme's background or signal" }),
  ),
];

const NAMED = String.raw`\b(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|brown|cyan|magenta|silver|gold|navy|teal|maroon|olive|lime|aqua|fuchsia|beige|ivory|indigo|violet|coral|salmon|tomato|crimson)\b`;
const QUOTE = "[\"'`]";
const NOT_QUOTE = "[^\"'`]";

/** Ways a colour is written: a hex, a colour function, and a named colour
 *  where colours go — a CSS colour property (borders, shadows and
 *  color-mix included), a JSX style object's, a canvas's fill or stroke, or a
 *  string that is only a colour's name. Case doesn't matter. */
const COLOURS: RegExp[] = [
  /#[0-9a-f]{3,8}\b/i,
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i,
  new RegExp(String.raw`(?:^|[\s;{])[a-z-]*(?:color|background|border|outline|shadow|fill|stroke|caret|accent|decoration|column-rule)[a-z-]*\s*:[^;]*${NAMED}`, "i"),
  new RegExp(String.raw`color-mix\([^)]*${NAMED}`, "i"),
  new RegExp(String.raw`\b(?:color|background\w*|border\w*|outline\w*|boxShadow|textShadow|fill|stroke|caretColor|accentColor)\s*:\s*${QUOTE}${NOT_QUOTE}*${NAMED}`, "i"),
  new RegExp(String.raw`\b(?:fillStyle|strokeStyle|shadowColor)\s*=\s*${QUOTE}`),
  new RegExp(String.raw`${QUOTE}\s*${NAMED}\s*${QUOTE}`, "i"),
];

/** `source` with its comments blanked (lines kept), and its `var(--…)`
 *  references, whose names may be colours. A `//` inside a string (a URL's)
 *  is not a comment. */
const code = (source: string, css: boolean): string => {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") out += source[++i] ?? "";
      else if (ch === quote) quote = null;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else if (!css && ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = (end < 0 ? source.length : end) - 1;
    } else {
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      out += ch;
    }
  }
  return out.replace(/var\(--[a-z0-9-]+\)/g, "");
};

const colourIn = (line: string): boolean => COLOURS.some((r) => r.test(line));

describe("colours", () => {
  it("come from the theme's tokens, outside the theme's colour files", () => {
    const found: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      const allowed = ALLOWED.filter((a) => a.file === file);
      const lines = source.split("\n");
      code(source, file.endsWith(".css"))
        .split("\n")
        .forEach((text, i) => {
          if (!colourIn(text) || allowed.some((a) => lines[i]!.includes(a.snippet))) return;
          found.push(`${file}:${i + 1}: ${lines[i]!.trim()}`);
        });
    }
    expect(found).toEqual([]);
  });

  it("allowed in on purpose are still there", () => {
    for (const a of ALLOWED) expect(SOURCES[a.file], `${a.file}: ${a.snippet}`).toContain(a.snippet);
  });

  it("are caught however they are written", () => {
    const css = [
      "color: #fff;",
      "box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);",
      "border-color: White;",
      "border: 1px solid black;",
      "box-shadow: 0 0 0 1px gray;",
      "background: color-mix(in srgb, var(--signal) 8%, white);",
      "fill: hsl(10 20% 30%)",
      "  * { color: red; }",
    ];
    for (const bad of css) expect(colourIn(code(bad, true)), bad).toBe(true);
    const ts = [
      'style={{ background: "#C9B8FF" }}',
      'style={{ borderColor: "white" }}',
      'style={{ border: "1px solid Black" }}',
      'g.fillStyle = "white";',
      "g.strokeStyle = `${tone}`;",
      'const ink = "Red";',
      'fetch("https://example.com/x"); const c = "white";',
    ];
    for (const bad of ts) expect(colourIn(code(bad, false)), bad).toBe(true);
    for (const fine of ["color: var(--ansi-red);", "background: color-mix(in srgb, var(--signal) 8%, transparent);", "border-color: currentColor;", "/* black shadows */ color: var(--text);"])
      expect(colourIn(code(fine, true)), fine).toBe(false);
    for (const fine of ['const url = "https://example.com/#top";', "// a black shadow", 'g.fillStyle = fill;', 'label: "Night"'])
      expect(colourIn(code(fine, false)), fine).toBe(false);
  });

  it("named by a variable are a variable something sets", () => {
    // The theme's, the ones Desk's styles and components set themselves, and
    // the rich renderers' own (--rich-*).
    const theme = new Set(BUILTIN.flatMap((t) => Object.keys({ ...cssVariables(derive(t)), ...dimVariables(derive(t)) })));
    const sources = Object.entries(SOURCES);
    const set = new Set(sources.map(([, s]) => s).flatMap((s) => [...s.matchAll(/["'\s{;(](--[a-z0-9-]+)["']?\s*[:,]/g)].map((m) => m[1]!)));
    const unknown = new Set<string>();
    for (const [file, s] of sources)
      for (const m of s.matchAll(/var\((--[a-z0-9-]+)\s*(,?)/g)) if (!m[2] && !theme.has(m[1]!) && !set.has(m[1]!) && !m[1]!.startsWith("--rich-")) unknown.add(`${file}: ${m[1]}`);
    expect([...unknown]).toEqual([]);
  });
});
