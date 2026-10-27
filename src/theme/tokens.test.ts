import { describe, expect, it } from "vitest";
import { DAY, HARBOUR, NIGHT } from "./builtin";
import { contrast, contrastChecks, cssVariables, derive, markFor, MARKS } from "./tokens";
import { parseTheme, serializeTheme, ThemeError } from "./toml";

describe("themes", () => {
  it("built-in themes are the designed colours exactly", () => {
    const night = derive(NIGHT).colors;
    expect([night.bg, night.signal, night.surface, night.blocked]).toEqual(["#111210", "#D4FF3A", "#171815", "#FFB547"]);
    const day = derive(DAY);
    expect(day.dark).toBe(false);
    expect([day.colors.onSignal, day.colors.signal]).toEqual(["#E4FF8F", "#161714"]);
    expect(derive(HARBOUR).colors.signal).toBe("#FF9F6B");
  });

  it("built-in themes pass their own contrast checks", () => {
    for (const t of [NIGHT, DAY, HARBOUR]) {
      for (const c of contrastChecks(derive(t))) expect(c.pass, `${t.id}: ${c.label} ${c.ratio.toFixed(2)}`).toBe(true);
    }
  });

  it("a theme needs only a background and a signal", () => {
    const t = derive(parseTheme("plum", 'name = "Plum"\n[colors]\nbackground = "#1A1423"\nsignal = "#C4B5FD"\n'));
    expect(t.dark).toBe(true);
    expect(t.colors.text).toBe("#F1F2EC");
    expect(contrast(t.colors.text, t.colors.bg)).toBeGreaterThan(12);
    expect(t.spec.density).toBe("cozy");
  });

  it("overrides win over derived colours", () => {
    const src = '[colors]\nbackground = "#F6F6F1"\nsignal = "#161714"\n[colors.override]\nblocked = "#B00000"\n';
    expect(derive(parseTheme("x", src)).colors.blocked).toBe("#B00000");
  });

  it("bad themes say what is wrong", () => {
    expect(() => parseTheme("x", "[colors]\nbackground = 'red'\nsignal = '#000000'")).toThrow(/background/);
    expect(() => parseTheme("x", "[colors]\nbackground = '#000000'\nsignal = '#FFFFFF'\n[colors.override]\nnope = '#000000'")).toThrow(ThemeError);
    expect(() => parseTheme("x", "[colors]\nbackground = '#000000'\nsignal = '#FFFFFF'\n[shape]\ncorners = 'wobbly'")).toThrow(/corners/);
    expect(() => parseTheme("x", "not = [toml")).toThrow(/TOML/);
  });

  it("serialising and parsing a theme gives the same theme", () => {
    const back = parseTheme(HARBOUR.id, serializeTheme(HARBOUR));
    expect(back).toEqual({ ...HARBOUR, text: undefined });
  });

  it("one token set feeds CSS, rich blocks and corners", () => {
    const vars = cssVariables(derive(NIGHT));
    expect(vars["--signal-soft-text"]).toBe("#DFFF7A");
    expect(vars["--rich-accent"]).toBe("#D4FF3A");
    expect(vars["--radius"]).toBe("14px");
  });

  it("an agent keeps the same mark colour", () => {
    expect(markFor("allan")).toBe(markFor("allan"));
    expect(MARKS).toContain(markFor("atlas"));
  });
});
