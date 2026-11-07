import { Terminal as XTerm } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { BUILTIN, DAY, HARBOUR, NIGHT } from "./builtin";
import { contrast, derive, isDarkGround, mix, TOKENS, type ThemeSpec } from "./tokens";
import { ANSI, dimmed, dimVariables, minimumContrast, terminalLight, terminalPalette, TERMINAL_CONTRAST, xtermTheme } from "./xterm";

/** The terminal colours Night and Harbour were drawn in before they were
 *  tokens: they must not move. */
const BEFORE = {
  night: { background: "#0C0D0B", foreground: "#D8DACF", cursor: "#D4FF3A", cursorAccent: "#0C0D0B", selectionBackground: "#445118", black: "#353634", red: "#FF8A7A", green: "#A6E37A", yellow: "#FFB547", blue: "#7DB8FF", magenta: "#C9B8FF", cyan: "#8FD8E8", white: "#D8DACF", brightBlack: "#8F9285", brightRed: "#FCA497", brightGreen: "#B9E797", brightYellow: "#FCC470", brightBlue: "#9AC7FA", brightMagenta: "#D3C7FA", brightCyan: "#A8DFE9", brightWhite: "#F1F2EC" },
  harbour: { background: "#0A121A", foreground: "#CFDBE6", cursor: "#FF9F6B", cursorAccent: "#0A121A", selectionBackground: "#4F3931", black: "#323A41", red: "#FF8F8F", green: "#7DD3A8", yellow: "#FFD166", blue: "#7CC4FA", magenta: "#C9B8FF", cyan: "#7CC4FA", white: "#CFDBE6", brightBlack: "#8A9DB0", brightRed: "#F9A7A9", brightGreen: "#97DABB", brightYellow: "#F9D88A", brightBlue: "#97CFF9", brightMagenta: "#D0C6FD", brightCyan: "#97CFF9", brightWhite: "#E6EEF5" },
};

const light = (spec: ThemeSpec) => ({ ...spec, id: "paper", overrides: {} });

describe("the terminal's colours", () => {
  it("are Night's and Harbour's exactly as before", () => {
    expect(xtermTheme(derive(NIGHT))).toEqual(BEFORE.night);
    expect(xtermTheme(derive(HARBOUR))).toEqual(BEFORE.harbour);
    expect(minimumContrast(derive(NIGHT).colors)).toBe(1);
  });

  it("are Day's as designed", () => {
    const t = xtermTheme(derive(DAY));
    expect([t.foreground, t.cursor, t.selectionBackground, t.black, t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan, t.white]).toEqual([
      "#24251F", "#3F5A06", "#D3DDA8", "#1B1C18", "#B3261E", "#2F6A12", "#8A5A00", "#1D58C0", "#7240C4", "#0A6B84", "#5E6157",
    ]);
  });

  it("every one is a token a theme can set, with no colour of its own", () => {
    const spec: ThemeSpec = { ...NIGHT, id: "x", overrides: Object.fromEntries(TOKENS.map((t, i) => [t, `#0000${i.toString(16).padStart(2, "0").toUpperCase()}`])) };
    const c = derive(spec).colors;
    const p = terminalPalette(derive(spec));
    const t = xtermTheme(derive(spec));
    for (const v of Object.values(t)) expect(Object.values(c)).toContain(v);
    expect(p.ansi).toEqual(ANSI.map((k) => c[k]));
    expect([p.background, p.foreground, p.cursor]).toEqual([c.sunken, c.termText, c.termCursor]);
  });

  it("bright colours follow their plain colour unless set", () => {
    const c = derive({ ...NIGHT, id: "x", overrides: { ...NIGHT.overrides, ansiMagenta: "#FF00FF" } }).colors;
    expect(c.ansiBrightMagenta).toBe(mix("#FF00FF", c.text, 0.25));
    const set = derive({ ...NIGHT, id: "x", overrides: { ...NIGHT.overrides, ansiBrightMagenta: "#FF77FF" } }).colors;
    expect(set.ansiBrightMagenta).toBe("#FF77FF");
  });

  it("yellow and blue are their own, apart from needs-you and working", () => {
    const c = derive({ ...DAY, id: "x", overrides: { ...DAY.overrides, blocked: "#990000", working: "#000099" } }).colors;
    expect([c.ansiYellow, c.ansiBlue]).toEqual(["#8A5A00", "#1D58C0"]);
  });

  it("read on every light ground: each ANSI colour but the ground's own, and dim text", () => {
    for (const spec of [DAY, light(DAY), { ...light(DAY), background: "#FFFFFF" }, { ...light(DAY), background: "#EEF2F6", signal: "#1F5FBF" }]) {
      const theme = derive(spec);
      const c = theme.colors;
      expect(terminalLight(c)).toBe(true);
      expect(minimumContrast(c)).toBe(TERMINAL_CONTRAST);
      for (const t of ANSI) expect(contrast(c[t], c.sunken), `${spec.id} ${t} ${c[t]} on ${c.sunken}`).toBeGreaterThanOrEqual(TERMINAL_CONTRAST);
      expect(contrast(c.termText, c.sunken)).toBeGreaterThanOrEqual(TERMINAL_CONTRAST);
      for (const [k, v] of Object.entries(dimVariables(theme))) expect(contrast(v, c.sunken), `${spec.id} ${k}`).toBeGreaterThanOrEqual(TERMINAL_CONTRAST);
    }
  });

  it("dim text is lighter than plain, and stays readable", () => {
    const dim = dimmed("#24251F", "#FFFFFF");
    expect(contrast(dim, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dim, "#FFFFFF")).toBeLessThan(contrast("#24251F", "#FFFFFF"));
    // xterm's own half-opacity dim would not read.
    expect(contrast(mix("#24251F", "#FFFFFF", 0.5), "#FFFFFF")).toBeLessThan(4.5);
  });

  it("a dark terminal in a light theme counts as dark, and its derived colours read on it", () => {
    const theme = derive({ ...DAY, id: "x", overrides: { ...DAY.overrides, sunken: "#101010" } });
    const c = theme.colors;
    expect(terminalLight(c)).toBe(false);
    expect(terminalPalette(theme).ground).toBe("dark");
    const derived = ["ansiBrightBlack", "ansiBrightRed", "ansiBrightGreen", "ansiBrightYellow", "ansiBrightBlue", "ansiBrightMagenta", "ansiBrightCyan", "ansiBrightWhite"] as const;
    for (const t of derived) expect(contrast(c[t], c.sunken), `${t} ${c[t]}`).toBeGreaterThanOrEqual(TERMINAL_CONTRAST);
    // Black is the ground's end there.
    expect(contrast(c.ansiBlack, c.sunken)).toBeLessThan(1.5);
  });

  it("a mid grey terminal is dark by luminance, and the hub is told so", () => {
    // Dark text reads a shade better on #777777, but its luminance is under 0.2.
    const theme = derive({ ...DAY, id: "x", overrides: { ...DAY.overrides, sunken: "#777777" } });
    expect(terminalLight(theme.colors)).toBe(false);
    expect(terminalPalette(theme).ground).toBe("dark");
    expect(terminalPalette(derive(DAY)).ground).toBe("light");
    expect(terminalPalette(derive(NIGHT)).ground).toBe("dark");
  });

  it("is light or dark by the rule a theme's own ground is told by, mid greys included", () => {
    for (const grey of ["#5A5A5A", "#707070", "#747474", "#777777", "#7A7A7A", "#808080", "#9A9A9A"]) {
      const c = derive({ ...DAY, id: "g", overrides: { ...DAY.overrides, sunken: grey } }).colors;
      expect(terminalLight(c), grey).toBe(!isDarkGround(grey));
      // The same grey as a theme's background is told the same way.
      expect(terminalLight(c), grey).toBe(!derive({ ...NIGHT, id: "g", background: grey, overrides: {} }).dark);
    }
    // Luminance 0.184, under 0.2: dark, as it always was.
    expect(terminalLight(derive({ ...DAY, id: "g", overrides: { ...DAY.overrides, sunken: "#777777" } }).colors)).toBe(false);
  });
});

describe("a pane answers a program's colour queries", () => {
  const answers = async (spec: ThemeSpec, query: string) => {
    window.matchMedia ??= (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
    const x = new XTerm({ rows: 5, cols: 40, theme: xtermTheme(derive(spec)) });
    const el = document.createElement("div");
    document.body.appendChild(el);
    x.open(el);
    const got: string[] = [];
    x.onData((d) => got.push(d));
    await new Promise<void>((r) => x.write(query, r));
    x.dispose();
    el.remove();
    return got;
  };
  const rgb = (hex: string) => `rgb:${[1, 3, 5].map((i) => hex.slice(i, i + 2).toLowerCase().repeat(2)).join("/")}`;

  it("with the theme's terminal colours, as the hub does when no pane is there", async () => {
    for (const spec of BUILTIN) {
      const p = terminalPalette(derive(spec));
      expect(await answers(spec, "\x1b]11;?\x1b\\\x1b]10;?\x07\x1b]4;5;?;13;?\x1b\\")).toEqual([
        `\x1b]11;${rgb(p.background)}\x1b\\`,
        `\x1b]10;${rgb(p.foreground)}\x1b\\`,
        `\x1b]4;5;${rgb(p.ansi[5]!)}\x1b\\`,
        `\x1b]4;13;${rgb(p.ansi[13]!)}\x1b\\`,
      ]);
    }
  });
});
