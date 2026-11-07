import type { ITheme } from "@xterm/xterm";
import { contrast, luminance, mix, type Palette, type Theme, type Token } from "./tokens";

/** The 16 ANSI colours' tokens, in their index order. */
export const ANSI: readonly Token[] = [
  "ansiBlack",
  "ansiRed",
  "ansiGreen",
  "ansiYellow",
  "ansiBlue",
  "ansiMagenta",
  "ansiCyan",
  "ansiWhite",
  "ansiBrightBlack",
  "ansiBrightRed",
  "ansiBrightGreen",
  "ansiBrightYellow",
  "ansiBrightBlue",
  "ansiBrightMagenta",
  "ansiBrightCyan",
  "ansiBrightWhite",
];

/** Whether a theme's terminal is light: by its ground's own luminance, so a
 *  dark terminal in a light theme (or the other way) is what it looks like. */
export const terminalLight = (c: Palette): boolean => luminance(c.sunken) >= 0.2;

/** The contrast text in a terminal keeps (WCAG AA). */
export const TERMINAL_CONTRAST = 4.5;

/** xterm's `minimumContrastRatio`: on a light ground, colours a program
 *  picked for a dark one (pale greys, pastel 24-bit colours) are darkened
 *  until they read; a dark ground draws what the program asked for. */
export const minimumContrast = (c: Palette): number => (terminalLight(c) ? TERMINAL_CONTRAST : 1);

export const xtermTheme = ({ colors: c }: Theme): ITheme => ({
  background: c.sunken,
  foreground: c.termText,
  cursor: c.termCursor,
  cursorAccent: c.sunken,
  selectionBackground: c.termSelection,
  black: c.ansiBlack,
  red: c.ansiRed,
  green: c.ansiGreen,
  yellow: c.ansiYellow,
  blue: c.ansiBlue,
  magenta: c.ansiMagenta,
  cyan: c.ansiCyan,
  white: c.ansiWhite,
  brightBlack: c.ansiBrightBlack,
  brightRed: c.ansiBrightRed,
  brightGreen: c.ansiBrightGreen,
  brightYellow: c.ansiBrightYellow,
  brightBlue: c.ansiBrightBlue,
  brightMagenta: c.ansiBrightMagenta,
  brightCyan: c.ansiBrightCyan,
  brightWhite: c.ansiBrightWhite,
});

/** Dim text (SGR 2) as drawn on a light ground: xterm draws it at half
 *  opacity, which no colour keeps readable on a light ground, so it is the
 *  colour moved toward the ground only as far as it still reads. One that
 *  barely reads already stays as it is. */
export const dimmed = (color: string, ground: string): string => {
  for (let p = 0.5; p > 0; p -= 0.01) {
    const next = mix(color, ground, p);
    if (contrast(next, ground) >= TERMINAL_CONTRAST) return next;
  }
  return color;
};

/** The CSS variables a light terminal's dim text is drawn with: the
 *  foreground's (`--term-dim`) and each ANSI colour's (`--term-dim-N`). */
export const dimVariables = ({ colors: c }: Theme): Record<string, string> => ({
  "--term-dim": dimmed(c.termText, c.sunken),
  ...Object.fromEntries(ANSI.map((t, i) => [`--term-dim-${i}`, dimmed(c[t], c.sunken)])),
});

/** What a hub tells the programs in its terminals when they ask (OSC 10,
 *  11 and 4), and when the ground turns light or dark (mode 2031): the
 *  colours the panes are drawn in. */
export interface TerminalPalette {
  foreground: string;
  background: string;
  cursor: string;
  ansi: string[];
  /** Light or dark, Desk's call ([`terminalLight`]): the hub has no rule of
   *  its own, so CLIs it starts read the ground the panes are drawn as. */
  ground: "light" | "dark";
}

export const terminalPalette = ({ colors: c }: Theme): TerminalPalette => ({
  foreground: c.termText,
  background: c.sunken,
  cursor: c.termCursor,
  ansi: ANSI.map((t) => c[t]),
  ground: terminalLight(c) ? "light" : "dark",
});
