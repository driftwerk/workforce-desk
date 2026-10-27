import { create } from "zustand";
import { BUILTIN } from "./builtin";
import { cssVariables, derive, type Theme, type ThemeSpec } from "./tokens";

export type ThemeChoice = string | "system";

interface ThemeState {
  choice: ThemeChoice;
  custom: ThemeSpec[];
  systemDark: boolean;
  setChoice: (choice: ThemeChoice) => void;
  setCustom: (custom: ThemeSpec[]) => void;
  setSystemDark: (dark: boolean) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  choice: "system",
  custom: [],
  systemDark: typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)").matches : true,
  setChoice: (choice) => set({ choice }),
  setCustom: (custom) => set({ custom }),
  setSystemDark: (systemDark) => set({ systemDark }),
}));

export const allThemes = (custom: readonly ThemeSpec[]): ThemeSpec[] => [
  ...BUILTIN,
  ...custom.filter((c) => !BUILTIN.some((b) => b.id === c.id)),
];

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
