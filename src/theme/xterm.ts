import type { ITheme } from "@xterm/xterm";
import { mix, type Theme } from "./tokens";

export const xtermTheme = ({ colors: c, dark }: Theme): ITheme => ({
  background: c.sunken,
  foreground: c.termText,
  cursor: c.signal,
  cursorAccent: c.sunken,
  selectionBackground: mix(c.sunken, c.signal, 0.28),
  black: dark ? mix(c.sunken, c.text, 0.18) : c.text,
  red: c.ansiRed,
  green: c.ansiGreen,
  yellow: c.blocked,
  blue: c.working,
  magenta: "#C9B8FF",
  cyan: c.ansiCyan,
  white: dark ? c.termText : mix(c.text, c.bg, 0.4),
  brightBlack: c.faint,
  brightRed: mix(c.ansiRed, c.text, 0.25),
  brightGreen: mix(c.ansiGreen, c.text, 0.25),
  brightYellow: mix(c.blocked, c.text, 0.25),
  brightBlue: mix(c.working, c.text, 0.25),
  brightMagenta: mix("#C9B8FF", c.text, 0.25),
  brightCyan: mix(c.ansiCyan, c.text, 0.25),
  brightWhite: c.text,
});
