import { differenceEuclidean, oklch } from "culori";
import { describe, expect, it } from "vitest";
import { BUILTIN, DAY, HARBOUR, NIGHT } from "./builtin";
import { codeColors, contrast, contrastChecks, cssVariables, derive, markFor, MARKS, monoStack, type ThemeSpec } from "./tokens";
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

  it("code in replies is readable in every built-in theme", () => {
    for (const t of [NIGHT, DAY, HARBOUR]) {
      const { bg, ...inks } = codeColors(derive(t).colors);
      for (const [token, ink] of Object.entries(inks)) {
        const ratio = contrast(ink, bg!);
        expect(ratio, `${t.id}: code ${token} ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    const vars = cssVariables(derive(HARBOUR));
    expect(vars["--rich-code-bg"]).toBe("#0A121A");
    expect(vars["--rich-code-keyword"]).toBe("#FF8F8F");
  });

  it("an agent keeps the same mark colour", () => {
    expect(markFor("allan")).toBe(markFor("allan"));
    expect(MARKS).toContain(markFor("atlas"));
  });
});

describe("sizes", () => {
  it("give chats and code their own CSS variables", () => {
    const vars = cssVariables(derive({ ...NIGHT, fonts: { ...NIGHT.fonts, size: 13, chatSize: 16, codeSize: 11.5 } }));
    expect([vars["--font-size"], vars["--font-size-chat"], vars["--font-size-code"]]).toEqual(["13px", "16px", "11.5px"]);
    expect(vars["--font-mono"]).toBe(monoStack(NIGHT));
  });
});

describe("a theme file from before chats and code had sizes", () => {
  const old = `name = "Mine"\n[colors]\nbackground = "#111210"\nsignal = "#D4FF3A"\n[type]\ndisplay = "Georgia"\nsize = 16\n`;

  it("looks as it did: its chats at its one size, its code at Desk's", () => {
    const t = parseTheme("mine", old);
    expect(t.fonts).toEqual({ ...NIGHT.fonts, display: "Georgia", size: 16, chatSize: 16, codeSize: 12.5 });
  });

  it("is written back with every size, and reads back the same", () => {
    const t = parseTheme("mine", old);
    const source = serializeTheme(t);
    expect(source).toContain("chat_size = 16");
    expect(source).toContain("code_size = 12.5");
    expect(parseTheme("mine", source)).toEqual(t);
  });

  it("refuses sizes out of range", () => {
    expect(() => parseTheme("x", old.replace("size = 16", "size = 16\nchat_size = 40"))).toThrow(ThemeError);
    expect(() => parseTheme("x", old.replace("size = 16", "size = 16\nchat_size = nan"))).toThrow(ThemeError);
    expect(() => parseTheme("x", old.replace("size = 16", "size = 16\ncode_size = \"big\""))).toThrow("[type].code_size must be a number from 9 to 22");
    expect(() => parseTheme("x", old.replace("size = 16", "size = 30"))).toThrow("[type].size must be a number from 10 to 22");
  });
});

describe("state colours", () => {
  const STATES = ["working", "blocked", "done", "ansiRed", "ansiGreen", "ansiCyan"] as const;
  /** What `derive` gave every dark and every light theme before they followed its text. */
  const BEFORE = {
    dark: { working: "#7DB8FF", blocked: "#FFB547", done: "#6EE7A8", ansiRed: "#FF8A7A", ansiGreen: "#A6E37A", ansiCyan: "#8FD8E8" },
    light: { working: "#1D5FD1", blocked: "#A85A00", done: "#17803F", ansiRed: "#B42318", ansiGreen: "#3F7A12", ansiCyan: "#0E7490" },
  };
  const distance = differenceEuclidean("oklab");
  const DARK_BLUE: ThemeSpec = { ...NIGHT, id: "dark-blue", name: "Dark Blue", background: "#050812", signal: "#00A3D7", text: "#AFB1AD", overrides: {} };
  /** A built-in's colours as `derive` makes them, with its text and none of its designed colours. */
  const derivedOnly = (t: ThemeSpec) => derive({ ...t, text: t.overrides.text, overrides: {} });

  const readable = (t: ThemeSpec) => {
    const { colors: c } = derive(t);
    for (const k of STATES) {
      for (const ground of [c.bg, c.surface, c.sunken]) {
        expect(contrast(c[k], ground), `${t.id}: ${k} ${c[k]} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(c.onBlocked, c.blocked), `${t.id}: onBlocked`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.blocked, c.blockedSoft), `${t.id}: blocked on blockedSoft`).toBeGreaterThanOrEqual(4.5);
  };

  it("dim with a theme's grey text, and still read", () => {
    const c = derive(DARK_BLUE).colors;
    for (const k of STATES) {
      expect(oklch(c[k])!.l, `${k} ${c[k]}`).toBeLessThan(oklch(BEFORE.dark[k])!.l - 0.1);
      expect(Math.abs(oklch(c[k])!.h! - oklch(BEFORE.dark[k])!.h!), `${k} keeps its hue`).toBeLessThan(6);
    }
    expect(c.working).not.toBe("#7DB8FF");
    readable(DARK_BLUE);
    // The states stay told apart.
    expect(new Set([c.working, c.blocked, c.done]).size).toBe(3);
    expect(Math.min(distance(c.working, c.blocked), distance(c.blocked, c.done), distance(c.working, c.done))).toBeGreaterThan(0.15);
  });

  it("on Desk's own text, or text near it, are close to what they were", () => {
    expect(STATES.map((k) => derive({ ...DARK_BLUE, text: undefined }).colors[k])).toEqual(STATES.map((k) => BEFORE.dark[k]));
    for (const t of BUILTIN) {
      const d = derivedOnly(t);
      for (const k of STATES) {
        const before = BEFORE[d.dark ? "dark" : "light"][k];
        expect(distance(d.colors[k], before), `${t.id}: ${k} ${d.colors[k]} against ${before}`).toBeLessThan(0.03);
      }
      readable({ ...t, text: t.overrides.text, overrides: {} });
    }
  });

  it("leave the built-ins' designed colours as they are", () => {
    for (const t of BUILTIN) {
      const c = derive(t).colors;
      for (const k of [...STATES, "onBlocked", "blockedSoft"] as const) expect(c[k], `${t.id}: ${k}`).toBe(t.overrides[k]);
    }
  });

  it("give way to the theme's own", () => {
    const t = { ...DARK_BLUE, overrides: { working: "#7DB8FF", ansiRed: "#FF0000" } };
    expect([derive(t).colors.working, derive(t).colors.ansiRed]).toEqual(["#7DB8FF", "#FF0000"]);
  });

  it("darken less with a light theme's grey text, and still read", () => {
    const light: ThemeSpec = { ...DAY, id: "slate", text: "#4A4D52", overrides: {} };
    const c = derive(light).colors;
    expect(derive(light).dark).toBe(false);
    for (const k of STATES) expect(oklch(c[k])!.l, `${k} ${c[k]}`).toBeGreaterThan(oklch(derivedOnly(DAY).colors[k])!.l - 0.001);
    readable(light);
    expect(c.onBlocked).toBe("#FFFFFF");
  });
});
