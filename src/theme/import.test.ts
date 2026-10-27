import { describe, expect, it } from "vitest";
import { NIGHT } from "./builtin";
import { detectFormat, importTheme, pickSignal } from "./import";
import { parseTheme, serializeTheme, ThemeError } from "./toml";
import { contrast, contrastChecks, derive, type ThemeSpec } from "./tokens";

const TOKYO_NIGHT = `{
  "$schema": "vscode://schemas/color-theme",
  "name": "Tokyo Night",
  "type": "dark",
  // Workbench colours
  "colors": {
    "editor.background": "#1a1b26",
    "editor.foreground": "#a9b1d6",
    "focusBorder": "#545c7e33",
    "button.background": "#3d59a1dd",
    "activityBarBadge.background": "#3d59a1",
    /* the integrated terminal */
    "terminal.foreground": "#787c99",
    "terminal.ansiRed": "#f7768e",
    "terminal.ansiGreen": "#73daca",
    "terminal.ansiCyan": "#7dcfff",
    "terminal.ansiBlack": "#363b54",
  },
  "tokenColors": [
    { "name": "Comment, // not a comment", "scope": ["comment"], "settings": { "foreground": "#51597d" } },
  ],
}
`;

const GITHUB_LIGHT = `{
  "name": "GitHub Light",
  "colors": {
    "editor.background": "#ffffff",
    "editor.foreground": "#1f2328",
    "focusBorder": "#0969da",
    "button.background": "#1f883d",
    "terminal.ansiRed": "#cf222e",
    "terminal.ansiGreen": "#116329",
    "terminal.ansiCyan": "#eeeeee"
  }
}`;

const CATPPUCCIN = `# Catppuccin Mocha, from ghostty's bundled themes
palette = 0=#45475a
palette = 1=#f38ba8
palette = 2=#a6e3a1
palette = 3=#f9e2af
palette = 4=#89b4fa
palette = 5=#f5c2e7
palette = 6=#94e2d5
palette = 7=#bac2de
palette = 8=#585b70
palette = 12=#89b4fa
background = 1e1e2e
foreground = cdd6f4
cursor-color = f5e0dc
cursor-text = 1e1e2e
selection-background = 353749
selection-foreground = cdd6f4
`;

const colour = (r: number, g: number, b: number) => `<dict>
		<key>Alpha Component</key>
		<real>1</real>
		<key>Blue Component</key>
		<real>${b}</real>
		<key>Color Space</key>
		<string>sRGB</string>
		<key>Green Component</key>
		<real>${g}</real>
		<key>Red Component</key>
		<real>${r}</real>
	</dict>`;

const DRACULA = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Ansi 0 Color</key>
	${colour(0.129, 0.133, 0.173)}
	<key>Ansi 1 Color</key>
	${colour(1, 0.333, 0.333)}
	<key>Ansi 2 Color</key>
	<dict>
		<key>Blue Component</key>
		<real>0.482</real>
		<key>Green Component</key>
		<real>0.98</real>
		<key>Red Component</key>
		<integer>0</integer>
	</dict>
	<key>Ansi 4 Color</key>
	${colour(0.741, 0.576, 0.976)}
	<key>Ansi 6 Color</key>
	${colour(0.545, 0.914, 0.992)}
	<key>Background Color</key>
	${colour(0.157, 0.165, 0.212)}
	<key>Cursor Color</key>
	${colour(0.973, 0.973, 0.949)}
	<key>Foreground Color</key>
	${colour(0.973, 0.973, 0.949)}
</dict>
</plist>
`;

const GRUVBOX = `scheme: "Gruvbox dark, medium"
author: "Dawid Kurek (dawikur@gmail.com), morhetz (https://github.com/morhetz/gruvbox)"
base00: "282828" # ----
base01: "3c3836" # ---
base02: "504945" # --
base03: "665c54" # -
base04: "bdae93" # +
base05: "d5c4a1" # ++
base06: "ebdbb2" # +++
base07: "fbf1c7" # ++++
base08: "fb4934" # red
base09: "fe8019" # orange
base0A: "fabd2f" # yellow
base0B: "b8bb26" # green
base0C: "8ec07c" # aqua/cyan
base0D: "83a598" # blue
base0E: "d3869b" # purple
base0F: "d65d0e" # brown
`;

const NORD = `system: "base16"
name: "Nord"
author: "arcticicestudio"
variant: "dark"
palette:
  base00: "#2E3440"
  base01: "#3B4252"
  base05: "#E5E9F0"
  base08: "#BF616A"
  base0B: "#A3BE8C"
  base0C: "#88C0D0"
  base0D: "#81A1C1"
  base0E: "#B48EAD"
`;

const readable = (spec: ThemeSpec) => {
  const theme = derive(spec);
  expect(contrast(theme.colors.signal, theme.colors.bg)).toBeGreaterThanOrEqual(3);
  expect(contrastChecks(theme).find((c) => c.label === "Button text on signal")?.pass).toBe(true);
  expect(parseTheme(spec.id, serializeTheme(spec))).toEqual({ ...spec, text: spec.text });
};

describe("theme import", () => {
  it("reads a VS Code theme with comments and trailing commas", () => {
    const t = importTheme("tokyo-night-color-theme.json", TOKYO_NIGHT);
    expect([t.id, t.name, t.background, t.text]).toEqual(["tokyo-night", "Tokyo Night", "#1A1B26", "#A9B1D6"]);
    expect(t.overrides).toMatchObject({ ansiRed: "#F7768E", ansiGreen: "#73DACA", ansiCyan: "#7DCFFF" });
    const [r, , b] = [1, 3, 5].map((i) => parseInt(t.signal.slice(i, i + 2), 16)) as [number, number, number];
    expect(b).toBeGreaterThan(r);
    readable(t);
  });

  it("takes a VS Code accent as it is when it already reads", () => {
    const t = importTheme("github-light.json", GITHUB_LIGHT);
    expect(derive(t).dark).toBe(false);
    expect(t.signal).toBe("#0969DA");
    expect(t.overrides.ansiRed).toBe("#CF222E");
    expect(t.overrides.ansiCyan).toBeUndefined();
    readable(t);
  });

  it("reads a Ghostty theme, skipping a cursor that is just the text colour", () => {
    const t = importTheme("catppuccin-mocha", CATPPUCCIN);
    expect([t.name, t.background, t.text, t.signal]).toEqual(["catppuccin-mocha", "#1E1E2E", "#CDD6F4", "#89B4FA"]);
    expect(t.overrides).toEqual({ ansiRed: "#F38BA8", ansiGreen: "#A6E3A1", ansiCyan: "#94E2D5" });
    readable(t);
  });

  it("reads an iTerm2 preset's float components", () => {
    const t = importTheme("Dracula.itermcolors", DRACULA);
    expect([t.name, t.background, t.text, t.signal]).toEqual(["Dracula", "#282A36", "#F8F8F2", "#BD93F9"]);
    expect(t.overrides).toEqual({ ansiRed: "#FF5555", ansiGreen: "#00FA7B", ansiCyan: "#8BE9FD" });
    readable(t);
  });

  it("reads base16 schemes in the flat and the palette layout", () => {
    const g = importTheme("gruvbox-dark-medium.yaml", GRUVBOX);
    expect([g.name, g.background, g.text]).toEqual(["Gruvbox dark, medium", "#282828", "#D5C4A1"]);
    expect(g.overrides).toEqual({ ansiRed: "#FB4934", ansiGreen: "#B8BB26", ansiCyan: "#8EC07C" });
    readable(g);
    const n = importTheme("nord.yml", NORD);
    expect([n.id, n.background, n.text]).toEqual(["nord", "#2E3440", "#E5E9F0"]);
    readable(n);
  });

  it("fills in Desk's fonts and shape", () => {
    const t = importTheme("nord.yaml", NORD);
    expect([t.fonts, t.density, t.corners]).toEqual([NIGHT.fonts, "cozy", "soft"]);
  });

  it("falls back to Desk's signal when nothing reads", () => {
    const spec = { ...NIGHT, overrides: {}, text: undefined };
    expect(pickSignal(spec, [])).toBe(NIGHT.signal);
    expect(pickSignal(spec, ["#F1F2EC"])).toBe(NIGHT.signal);
  });

  it("knows a format by its extension, or else by its content", () => {
    expect(detectFormat("a.json", "")).toBe("vscode");
    expect(detectFormat("a.itermcolors", "")).toBe("iterm");
    expect(detectFormat("a.yml", "")).toBe("base16");
    expect(detectFormat("/themes/plum.toml", "")).toBe("desk");
    expect(detectFormat("catppuccin-mocha", CATPPUCCIN)).toBe("ghostty");
    expect(detectFormat("Dracula", DRACULA)).toBe("iterm");
    expect(detectFormat("theme", TOKYO_NIGHT)).toBe("vscode");
    expect(detectFormat("gruvbox.txt", GRUVBOX)).toBe("base16");
    expect(detectFormat("plum", '[colors]\nbackground = "#1A1423"\nsignal = "#C4B5FD"\n')).toBe("desk");
    expect(() => detectFormat("notes.txt", "hello")).toThrow(ThemeError);
  });

  it("imports a Desk theme file as it is", () => {
    const t = importTheme("Plum.toml", 'name = "Plum"\n[colors]\nbackground = "#1A1423"\nsignal = "#C4B5FD"\n');
    expect([t.id, t.name, t.signal]).toEqual(["plum", "Plum", "#C4B5FD"]);
  });

  it("says what is wrong with a file it can't use", () => {
    expect(() => importTheme("x.json", "{ nope")).toThrow(/not valid JSON/);
    expect(() => importTheme("x.json", '{ "name": "x" }')).toThrow(/no "colors"/);
    expect(() => importTheme("x.json", '{ "colors": { "focusBorder": "#fff" } }')).toThrow(/editor\.background/);
    expect(() => importTheme("config", "foreground = cdd6f4\npalette = 1=#f38ba8")).toThrow(/background = /);
    expect(() => importTheme("config", "background = notacolour")).toThrow(/is not a colour/);
    expect(() => importTheme("x.itermcolors", "<plist><dict><key>")).toThrow(/not a valid plist/);
    expect(() => importTheme("x.itermcolors", '<plist version="1.0"><dict></dict></plist>')).toThrow(/Background Color/);
    expect(() => importTheme("x.yaml", 'scheme: "x"\nbase05: "ffffff"')).toThrow(/base00/);
    for (const [name, src] of [
      ["x.json", "{"],
      ["config", "background = notacolour"],
      ["x.yaml", ""],
    ])
      expect(() => importTheme(name!, src!)).toThrow(ThemeError);
  });
});
