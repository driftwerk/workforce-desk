// Saving what Desk itself made from a reply — a chart's picture, a table's
// CSV, a diagram — where the person chooses.

import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { safeFilename } from "../platform";
import { preview } from "../preview";

/** Asks where to save `blob`, and writes it there; false when the person
 *  thought better of it. The browser preview downloads it. */
export const saveBlobAs = async (blob: Blob, filename: string): Promise<boolean> => {
  if (preview) {
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: filename }).click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  }
  const path = await save({ defaultPath: safeFilename(filename) });
  if (!path) return false;
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return true;
};

/** {@link saveBlobAs}, for a rich block's host: what went wrong is logged. */
export const saveMadeFile = (blob: Blob, filename: string): void => {
  saveBlobAs(blob, filename).catch((e: unknown) => console.warn(`couldn't save ${filename}:`, e));
};
