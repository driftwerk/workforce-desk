import { themeFiles } from "../platform";
import { parseTheme, ThemeError } from "./toml";
import type { ThemeSpec } from "./tokens";

/** The themes in Desk's themes folder; one that can't be read is left out
 *  (and said why in the log). */
export const loadCustomThemes = async (): Promise<ThemeSpec[]> =>
  (await themeFiles()).flatMap((f) => {
    try {
      return [parseTheme(f.id, f.source)];
    } catch (e) {
      if (e instanceof ThemeError) console.warn(`theme ${f.id}.toml: ${e.message}`);
      return [];
    }
  });
