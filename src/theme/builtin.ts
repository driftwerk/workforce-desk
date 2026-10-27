import type { ThemeSpec } from "./tokens";

const FONTS = { display: "Bricolage Grotesque Variable", ui: "Figtree Variable", mono: "Geist Mono Variable", size: 14 };

const builtin = (spec: Omit<ThemeSpec, "fonts" | "density" | "corners">): ThemeSpec => ({
  ...spec,
  fonts: FONTS,
  density: "cozy",
  corners: "soft",
});

export const NIGHT = builtin({
  id: "night",
  name: "Night",
  background: "#111210",
  signal: "#D4FF3A",
  overrides: {
    surface: "#171815",
    raised: "#1E1F1B",
    sunken: "#0C0D0B",
    border: "#2C2E28",
    text: "#F1F2EC",
    muted: "#B4B7AA",
    faint: "#8F9285",
    onSignal: "#161A05",
    signalSoft: "#262E10",
    signalSoftText: "#DFFF7A",
    working: "#7DB8FF",
    blocked: "#FFB547",
    onBlocked: "#2B1B03",
    blockedSoft: "#2A2110",
    done: "#6EE7A8",
    idle: "#6F7268",
    termText: "#D8DACF",
    ansiCyan: "#8FD8E8",
    ansiGreen: "#A6E37A",
    ansiRed: "#FF8A7A",
  },
});

export const DAY = builtin({
  id: "day",
  name: "Day",
  background: "#F6F6F1",
  signal: "#161714",
  overrides: {
    surface: "#EDEDE6",
    raised: "#FFFFFF",
    sunken: "#FFFFFF",
    border: "#DCDCD2",
    text: "#161714",
    muted: "#4E5048",
    faint: "#66685F",
    onSignal: "#E4FF8F",
    signalSoft: "#E4FF8F",
    signalSoftText: "#2F3D00",
    working: "#1D5FD1",
    blocked: "#A85A00",
    onBlocked: "#FFFFFF",
    blockedSoft: "#FFF1DC",
    done: "#17803F",
    idle: "#75776E",
    termText: "#23241F",
    ansiCyan: "#0E7490",
    ansiGreen: "#3F7A12",
    ansiRed: "#B42318",
  },
});

export const HARBOUR = builtin({
  id: "harbour",
  name: "Harbour",
  background: "#0E1822",
  signal: "#FF9F6B",
  overrides: {
    surface: "#122030",
    raised: "#172739",
    sunken: "#0A121A",
    border: "#25394B",
    text: "#E6EEF5",
    muted: "#A9BACB",
    faint: "#8A9DB0",
    onSignal: "#2A1206",
    signalSoft: "#3A2418",
    signalSoftText: "#FFC4A3",
    working: "#7CC4FA",
    blocked: "#FFD166",
    onBlocked: "#2A1F02",
    blockedSoft: "#2E2814",
    done: "#7DD3A8",
    idle: "#70849A",
    termText: "#CFDBE6",
    ansiCyan: "#7CC4FA",
    ansiGreen: "#7DD3A8",
    ansiRed: "#FF8F8F",
  },
});

export const BUILTIN: readonly ThemeSpec[] = [NIGHT, DAY, HARBOUR];

/** Logo dot on Day uses the signal-green, since Day's signal is ink. */
export const logoDot = (spec: ThemeSpec): string => (spec.id === "day" ? "#9BC400" : spec.signal);
