import { describe, expect, it, vi } from "vitest";
import { BUILTIN, DAY, HARBOUR, NIGHT } from "./builtin";
import before from "./fixtures/before-day.json";
import { ALPHA_TOKENS, bestOn, contrast, contrastChecks, cssVariables, derive, isDarkGround, isHex, ON_FILL_CHOICES, scaleAlpha, SERIES_MARK_TOKENS, TOKENS, type ThemeSpec } from "./tokens";
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
      // Buttons transparent, answer buttons in the signal, no glow or rings,
      // a working ticket's edge the border, settings cards raised.
      expect([c.buttonFill, c.askGlow, c.activeRing, c.focusRing], spec.id).toEqual(["#00000000", "#00000000", "#00000000", "#00000000"]);
      expect([c.approve, c.onApprove, c.activeEdge, c.cardFill], spec.id).toEqual([c.signal, c.onSignal, c.border, c.raised]);
      expect([c.modeGround, c.modeFill, c.onModeFill], spec.id).toEqual([c.sunken, c.signal, c.onSignal]);
    }
    const vars = cssVariables(derive(NIGHT));
    // Today's .35, .25 and .4 black shadows.
    expect([vars["--shadow"], vars["--shadow-soft"], vars["--shadow-strong"]]).toEqual(["#00000059", "#00000040", "#00000066"]);
  });
});

describe("a board mark's initials", () => {
  it("are whichever of ink and white reads better on the worst of the series they fill", () => {
    expect([NIGHT, HARBOUR, DAY].map((s) => derive(s).colors.onSeriesMark)).toEqual(["#161714", "#161714", "#FFFFFF"]);
    // A light theme that sets no series has the light defaults, where white
    // falls to 2.69 and ink only to 3.12: ink.
    const light: ThemeSpec = { ...DAY, id: "light", overrides: {} };
    expect(derive(light).dark).toBe(false);
    expect(derive(light).colors.onSeriesMark).toBe("#161714");
    // Its own series count: dark ones take white.
    const deep: ThemeSpec = { ...light, overrides: Object.fromEntries(SERIES_MARK_TOKENS.map((t) => [t, "#1F3A66"])) };
    expect(derive(deep).colors.onSeriesMark).toBe("#FFFFFF");
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
  it("is told by Desk's fixed rule, luminance under 0.2, so a theme that sets nothing looks as it did", () => {
    expect(isDarkGround("#111210")).toBe(true);
    expect(isDarkGround("#FBFAF7")).toBe(false);
    // Luminance 0.195: dark, as before, though dark text reads a little better.
    expect(isDarkGround("#7A7A7A")).toBe(true);
    expect(contrast("#161714", "#7A7A7A")).toBeGreaterThan(contrast("#F1F2EC", "#7A7A7A"));
    expect(derive({ ...NIGHT, id: "g", background: "#7A7A7A", overrides: {} }).dark).toBe(true);
  });

  it("gives text on the signal by Desk's fixed rule, and the editor offers the text that reads", () => {
    // Luminance 0.33: white by the rule, at 3.0:1; ink would read at 7.1:1.
    const t = derive({ ...NIGHT, id: "s", signal: "#FF6B9A", overrides: {} });
    expect(t.colors.onSignal).toBe("#FFFFFF");
    const check = contrastChecks(t).find((c) => c.fg === "onSignal")!;
    expect(check.pass).toBe(false);
    expect(check.readable).toBe("#161714");
    expect(bestOn("#FF6B9A", ON_FILL_CHOICES)).toBe("#161714");
    // A pair that passes, or one that isn't text, offers nothing.
    expect(contrastChecks(derive(NIGHT)).every((c) => !c.readable)).toBe(true);
  });
});

describe("a theme file from a newer Desk", () => {
  it("opens, without the colours this Desk doesn't know", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = parseTheme("newer", '[colors]\nbackground = "#111210"\nsignal = "#D4FF3A"\n[colors.override]\nblocked = "#FFB547"\nsomethingNew = "#123456"\n');
    expect(t.overrides).toEqual({ blocked: "#FFB547" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"somethingNew"'));
    warn.mockRestore();
  });
});
