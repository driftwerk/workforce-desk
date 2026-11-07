import { useSettings } from "../settings/store";
import { loadCustomThemes } from "./custom";
import { applyTheme, resolveTheme, useThemeStore } from "./store";
import type { Theme } from "./tokens";

/** The custom themes' first read, made before the first render. */
let firstThemes: Promise<void> | null = null;

/** The custom themes, read: the first read if it is the one before the
 *  first render (once), else `read` now. Its failure is the caller's. */
export const customThemesRead = (read: () => Promise<void>): Promise<void> => {
  const first = firstThemes;
  firstThemes = null;
  return first ?? read();
};

/** How long the first render waits on the settings and themes files. */
const READ_WAIT_MS = 1500;

/** Before the first render: the saved theme choice and the custom themes
 *  are read and that theme painted, so the window first shows in it (not in
 *  Auto's, or Night while a custom theme's file is read). What can't be read
 *  is read again, and said, once the shell is up. */
export const paintSavedTheme = async (wait = READ_WAIT_MS): Promise<Theme> => {
  const { setCustom } = useThemeStore.getState();
  firstThemes = loadCustomThemes().then(setCustom);
  const read = Promise.allSettled([useSettings.getState().load(), firstThemes]);
  // A read that hangs never keeps the window from showing.
  await Promise.race([read, new Promise((done) => setTimeout(done, wait))]);
  const { choice, custom, systemDark } = useThemeStore.getState();
  const theme = resolveTheme(choice, custom, systemDark);
  applyTheme(theme);
  return theme;
};
