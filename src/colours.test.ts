import { describe, expect, it } from "vitest";
import { BUILTIN } from "./theme/builtin";
import { cssVariables, derive } from "./theme/tokens";
import { dimVariables } from "./theme/xterm";

// Every colour Desk draws comes from a theme token, which the theme editor and
// a theme's file can set. This fails on a colour written into the styles or
// the components instead; the theme module (src/theme), which defines the
// tokens and their defaults, is where colours belong.

/** Desk's styles and components, by their path under src/: all but the
 *  theme module, the test helpers and the tests. */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>(["./**/*.{css,ts,tsx}", "!./theme/**", "!./testing/**", "!./**/*.test.{ts,tsx}", "!./**/*.d.ts"], { query: "?raw", import: "default", eager: true })).map(
    ([path, source]) => [path.replace(/^\.\//, ""), source],
  ),
);

/** Colours written in on purpose, each with why. A snippet no longer found
 *  fails too, so the list stays true. */
const ALLOWED: { file: string; snippet: string; why: string }[] = [
  { file: "styles/app.css", snippet: "linear-gradient(#000 0 0) content-box", why: "a mask's shape; its colour is never drawn" },
  { file: "styles/app.css", snippet: "linear-gradient(#000 0 0);", why: "a mask's shape; its colour is never drawn" },
  { file: "emoji/data.ts", snippet: 'pixels("#00f")', why: "a probe drawn off screen to tell colour emoji from text" },
  { file: "emoji/data.ts", snippet: 'pixels("#f00")', why: "a probe drawn off screen to tell colour emoji from text" },
  ...["#111210", "#0E1822", "#1A1423", "#FBFAF7", "#FFFFFF", "#EEF2F6", "#D4FF3A", "#FF9F6B", "#7DD3FC", "#C4B5FD", "#FF6B9A", "#161714", "#3F5A06", "#1F5FBF", "#B4440F", "#5B45C9", "#B02A5B", "#1B1C18"].map(
    (hex) => ({ file: "settings/editing.ts", snippet: `hex: "${hex}"`, why: "the editor's swatches: colours offered to set a theme's background or signal" }),
  ),
];

const NAMED = "white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|brown|cyan|magenta|silver|gold|navy|teal|maroon|olive|lime|aqua|fuchsia";
const COLOUR = new RegExp(String.raw`#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|(?:color|background|border|fill|stroke|outline|shadow|caret|accent|decoration)[a-z-]*\s*[:=]\s*["'{]?\s*(?:${NAMED})\b`, "g");

/** A line without its comments and its `var(--…)` references (whose names may be colours). */
const code = (line: string) => line.replace(/\/\*.*?\*\/|\/\/.*$|var\(--[a-z0-9-]+\)/g, "");

describe("colours", () => {
  it("come from the theme's tokens, outside the theme module", () => {
    const found: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      const allowed = ALLOWED.filter((a) => a.file === file);
      source
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\*|\/\*|\/\/)/.test(line)) return;
          const text = code(line);
          if (!COLOUR.test(text)) return;
          COLOUR.lastIndex = 0;
          if (allowed.some((a) => line.includes(a.snippet))) return;
          found.push(`${file}:${i + 1}: ${line.trim()}`);
        });
      COLOUR.lastIndex = 0;
    }
    expect(found).toEqual([]);
  });

  it("allowed in on purpose are still there", () => {
    for (const a of ALLOWED) expect(SOURCES[a.file], `${a.file}: ${a.snippet}`).toContain(a.snippet);
  });

  it("are caught however they are written", () => {
    for (const bad of ["color: #fff;", "box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);", 'style={{ background: "#C9B8FF" }}', "border-color: white;", "fill: hsl(10 20% 30%)"]) {
      COLOUR.lastIndex = 0;
      expect(COLOUR.test(code(bad)), bad).toBe(true);
    }
    for (const fine of ["color: var(--ansi-red);", "background: color-mix(in srgb, var(--signal) 8%, transparent);", "border-color: currentColor;"]) {
      COLOUR.lastIndex = 0;
      expect(COLOUR.test(code(fine)), fine).toBe(false);
    }
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
