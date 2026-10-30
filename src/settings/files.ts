import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { serializeTheme } from "../theme/toml";
import type { ThemeSpec } from "../theme/tokens";
import { baseName } from "../ui/paths";

export interface PickedFile {
  name: string;
  source: string;
}

/** No filters: Ghostty themes usually have no extension. */
export const pickThemeFile = async (): Promise<PickedFile | null> => {
  const path = await open({ title: "Import a theme", multiple: false, directory: false });
  if (typeof path !== "string") return null;
  return { name: baseName(path), source: await readTextFile(path) };
};

export const exportThemeFile = async (spec: ThemeSpec): Promise<void> => {
  const path = await save({
    title: "Export theme",
    defaultPath: `${spec.id}.toml`,
    filters: [{ name: "Desk theme", extensions: ["toml"] }],
  });
  if (path) await writeTextFile(path, serializeTheme(spec));
};
