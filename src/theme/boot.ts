import { useSettings } from "../settings/store";
import { loadCustomThemes } from "./custom";
import { applyTheme, resolveTheme, useThemeStore } from "./store";
import type { Theme } from "./tokens";

/** How long the first render waits on the settings and themes files. */
const READ_WAIT_MS = 1500;

/** Before the first render: the saved theme choice and the custom themes
 *  are read and that theme painted, so the window first shows in it (not in
 *  Auto's, or Night while a custom theme's file is read). What can't be read
 *  is read again, and said, once the shell is up. */
export const paintSavedTheme = async (wait = READ_WAIT_MS): Promise<Theme> => {
  const { setCustom } = useThemeStore.getState();
  const read = Promise.allSettled([useSettings.getState().load(), loadCustomThemes().then(setCustom)]);
  // A read that hangs never keeps the window from showing.
  await Promise.race([read, new Promise((done) => setTimeout(done, wait))]);
  const { choice, custom, systemDark } = useThemeStore.getState();
  const theme = resolveTheme(choice, custom, systemDark);
  applyTheme(theme);
  return theme;
};
