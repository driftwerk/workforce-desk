import { describe, expect, it } from "vitest";
import { BUILTIN, HARBOUR, NIGHT } from "./builtin";
import before from "./fixtures/before-day.json";
import { ALPHA_TOKENS, contrast, cssVariables, derive, isDarkGround, isHex, scaleAlpha, TOKENS, type ThemeSpec } from "./tokens";
import { parseTheme, serializeTheme, ThemeError } from "./toml";
import { dimVariables, xtermTheme } from "./xterm";

/** What every theme drew before the shadows, marks, logo, diffs and charts
 *  were tokens (fixtures/before-day.json, made from the code before them):
 *  Night, Harbour, and three themes that set only their own colours. */
const THEMES: Record<string, ThemeSpec> = {
  night: NIGHT,
  harbour: HARBOUR,
  ...Object.fromEntries(Object.entries(before.custom).map(([id, source]) => [id, parseTheme(id, source)])),
};

const upper = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? v.toUpperCase() : v]));

describe("themes from before the new tokens", () => {
  for (const [id, spec] of Object.entries(THEMES)) {
    it(`${id} gives every colour it gave before`, () => {
      const t = derive(spec);
      const was = (before.themes as Record<string, { dark: boolean; css: Record<string, string>; xterm: Record<string, string> }>)[id]!;
      expect(t.dark).toBe(was.dark);
      const now = { ...cssVariables(t), ...dimVariables(t) };
      // Every variable it set is set as it was (a chart's series were
      // lower case, which draws the same); new ones are only added.
      expect(upper(Object.fromEntries(Object.keys(was.css).map((k) => [k, now[k]])))).toEqual(upper(was.css));
      expect(xtermTheme(t)).toEqual(was.xterm);
    });
  }

  it("draw the new tokens as they drew those colours: black shadows, no lift or edge, the signal's logo dot", () => {
    for (const spec of Object.values(THEMES)) {
      const c = derive(spec).colors;
      expect([c.shadow, c.lift, c.edge, c.onMark], spec.id).toEqual(["#00000059", "#00000000", "#00000000", "#161714"]);
      expect(c.logoDot, spec.id).toBe(c.signal);
      expect([c.mark1, c.mark2, c.mark3, c.mark4, c.mark5, c.mark6]).toEqual(["#C9B8FF", "#FFC98A", "#A8D8FF", "#A6EBC9", "#FFB3C7", "#E8DDB5"]);
    }
    const vars = cssVariables(derive(NIGHT));
    // Today's .35, .25 and .4 black shadows.
    expect([vars["--shadow"], vars["--shadow-soft"], vars["--shadow-strong"]]).toEqual(["#00000059", "#00000040", "#00000066"]);
  });
});

describe("every token", () => {
  for (const spec of [...BUILTIN, ...Object.values(THEMES)]) {
    it(`resolves to a colour in ${spec.id}`, () => {
      const { colors } = derive(spec);
      const vars = cssVariables(derive(spec));
      for (const t of TOKENS) {
        const alpha = (ALPHA_TOKENS as readonly string[]).includes(t);
        expect(isHex(colors[t], alpha), `${spec.id}: ${t} = ${colors[t]}`).toBe(true);
        expect(vars[`--${t.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`], `${spec.id}: --${t}`).toBe(colors[t]);
      }
    });
  }

  it("can be set in a theme file, and is kept when saved", () => {
    const overrides = Object.fromEntries(TOKENS.map((t, i) => [t, `#1020${(i + 16).toString(16).toUpperCase().padStart(2, "0")}`]));
    const toml = `[colors]\nbackground = "#FBFAF7"\nsignal = "#3F5A06"\n[colors.override]\n${Object.entries(overrides)
      .map(([k, v]) => `${k} = "${v}"`)
      .join("\n")}\n`;
    const spec = parseTheme("all", toml);
    expect(derive(spec).colors).toEqual(overrides);
    expect(parseTheme("all", serializeTheme(spec))).toEqual(spec);
  });
});

describe("colours with alpha", () => {
  it("are taken for shadow, lift and edge only", () => {
    const src = (k: string, v: string) => `[colors]\nbackground = "#111210"\nsignal = "#D4FF3A"\n[colors.override]\n${k} = "${v}"\n`;
    for (const k of ["shadow", "lift", "edge"]) expect(derive(parseTheme("x", src(k, "#3c341e38"))).colors[k as "shadow"]).toBe("#3C341E38");
    expect(() => parseTheme("x", src("text", "#3C341E38"))).toThrow(ThemeError);
    expect(() => parseTheme("x", src("shadow", "#3C341E3"))).toThrow(/#11223344/);
    expect(() => parseTheme("x", "[colors]\nbackground = \"#11121080\"\nsignal = \"#D4FF3A\"\n")).toThrow(ThemeError);
  });

  it("scale their alpha, solid colours from opaque", () => {
    expect(scaleAlpha("#3C341E38", 0.5)).toBe("#3C341E1C");
    expect(scaleAlpha("#000000", 0.25)).toBe("#00000040");
    expect(scaleAlpha("#00000080", 4)).toBe("#000000FF");
  });
});

describe("a dark ground or a light one", () => {
  it("is the one whose text reads better on it, not a luminance cut-off", () => {
    expect(isDarkGround("#111210")).toBe(true);
    expect(isDarkGround("#FBFAF7")).toBe(false);
    // A mid grey reads better with dark text.
    expect(isDarkGround("#8A8A8A")).toBe(false);
    // Just under the old cut-off (luminance 0.2) and light text still reads worse.
    expect(isDarkGround("#7A7A7A")).toBe(contrast("#F1F2EC", "#7A7A7A") > contrast("#161714", "#7A7A7A"));
    for (const bg of ["#000000", "#333333", "#595959", "#6E6E6E", "#808080", "#A0A0A0", "#FFFFFF"]) {
      const t = derive({ ...NIGHT, id: "g", background: bg, overrides: {} });
      expect(contrast(t.colors.text, bg), bg).toBeGreaterThanOrEqual(Math.max(contrast("#161714", bg), contrast("#F1F2EC", bg)) - 0.01);
    }
  });

  it("gives button text that reads best on the signal", () => {
    for (const signal of ["#D4FF3A", "#3F5A06", "#8A8A8A", "#1F5FBF", "#FF6B9A", "#9A9A9A"]) {
      const c = derive({ ...NIGHT, id: "s", signal, overrides: {} }).colors;
      expect(contrast(c.onSignal, signal), signal).toBeGreaterThanOrEqual(Math.max(contrast("#161714", signal), contrast("#FFFFFF", signal)));
    }
  });
});
