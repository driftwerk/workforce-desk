import { create } from "zustand";
import { BUILTIN } from "./builtin";
import { cssVariables, derive, type Theme, type ThemeSpec } from "./tokens";

export type ThemeChoice = string | "system";

/** The three looks the sidebar always offers: Auto (Night or Day with
 *  the system), Night and Day. Every other theme is picked from the chooser. */
export const MODES = ["system", "night", "day"] as const;
export type Mode = (typeof MODES)[number];

export const isMode = (choice: ThemeChoice): choice is Mode => (MODES as readonly string[]).includes(choice);

/** The theme the chooser shows until another is picked. */
export const DEFAULT_PICK = "harbour";

interface ThemeState {
  choice: ThemeChoice;
  /** The chooser's theme: the last theme other than Auto, Night and Day
   *  that was applied, kept while one of those is on. */
  pick: string;
  custom: ThemeSpec[];
  systemDark: boolean;
  setChoice: (choice: ThemeChoice) => void;
  setPick: (pick: string) => void;
  setCustom: (custom: ThemeSpec[]) => void;
  setSystemDark: (dark: boolean) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  choice: "system",
  pick: DEFAULT_PICK,
  custom: [],
  systemDark: typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)").matches : true,
  setChoice: (choice) => set(isMode(choice) ? { choice } : { choice, pick: choice }),
  setPick: (pick) => set({ pick }),
  setCustom: (custom) => set({ custom }),
  setSystemDark: (systemDark) => set({ systemDark }),
}));

export const allThemes = (custom: readonly ThemeSpec[]): ThemeSpec[] => [
  ...BUILTIN,
  ...custom.filter((c) => !BUILTIN.some((b) => b.id === c.id)),
];

/** Themes the chooser lists: every one but Night and Day. */
export const chooserThemes = (custom: readonly ThemeSpec[]): ThemeSpec[] =>
  allThemes(custom).filter((t) => t.id !== "night" && t.id !== "day");

/** The chooser's theme as it is now; Harbour when the picked one is gone
 *  (or its file hasn't been read yet). */
export const pickedTheme = (pick: string, custom: readonly ThemeSpec[]): ThemeSpec => {
  const themes = chooserThemes(custom);
  return themes.find((t) => t.id === pick) ?? themes.find((t) => t.id === DEFAULT_PICK) ?? themes[0]!;
};

export const resolveTheme = (choice: ThemeChoice, custom: readonly ThemeSpec[], systemDark: boolean): Theme => {
  const id = choice === "system" ? (systemDark ? "night" : "day") : choice;
  const spec = allThemes(custom).find((t) => t.id === id) ?? BUILTIN[0]!;
  return derive(spec);
};

export const useTheme = (): Theme => {
  const { choice, custom, systemDark } = useThemeStore();
  return resolveTheme(choice, custom, systemDark);
};

export const applyTheme = (theme: Theme, root: HTMLElement = document.documentElement): void => {
  for (const [k, v] of Object.entries(cssVariables(theme))) root.style.setProperty(k, v);
  root.dataset.theme = theme.dark ? "dark" : "light";
  root.style.colorScheme = theme.dark ? "dark" : "light";
};
