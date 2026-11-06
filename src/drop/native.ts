// The page's side of files dropped on Desk, through its native side
// (src-tauri/src/drops.rs): following the window's drops, a dropped file's
// size and bytes for a message, the paths a terminal is given, and an
// image pasted into one.

import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { LOCAL, type MachineId } from "../hub/machines";
import { inApp, invoke, subscribe } from "../platform";
import { useHost } from "../shell/host";
import { DropRouter, toCss, zoneAt, type DragDropPayload } from "./route";

/** Follows this window's drops of files, from now on. Once per window. */
export const followDrops = (): (() => void) => {
  if (!inApp) return () => {};
  const router = new DropRouter((p) => {
    const { x, y } = toCss(p, useHost.getState().platform, window.devicePixelRatio);
    return zoneAt(x, y);
  });
  return subscribe(getCurrentWebview().onDragDropEvent((e) => router.handle(e.payload as DragDropPayload)));
};

/** A dropped file as Desk's native side describes it. */
export interface DroppedFile {
  path: string;
  name: string;
  size: number;
  folder: boolean;
}

export const droppedFiles = (paths: string[]): Promise<DroppedFile[]> => invoke<DroppedFile[]>("dropped_files", { paths });

/** The media types of what's commonly attached, by extension. */
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
};

/** The media type a file named `name` most likely has; "" when unknown. */
export const typeOf = (name: string): string => TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "";

/** A dropped file, read whole, for a message. */
export const readDropped = async (f: DroppedFile): Promise<File> => {
  const bytes = await invoke<ArrayBuffer>("dropped_file_read", { path: f.path });
  return new File([bytes], f.name, { type: typeOf(f.name) });
};

/** How far a copy to a machine has got. */
export interface Progress {
  sent: number;
  total: number;
}

const machineArg = (machine: MachineId): string | null => (machine === LOCAL ? null : machine);

/** The dropped `paths` as the shell of terminal `scope` (a session's id, or
 *  a grid terminal's) on `machine` names them: copied there first when it
 *  is a machine, `onProgress` hearing how far, and stopped by
 *  `cancelDrop(token)`. */
export const terminalDrop = (machine: MachineId, scope: string, paths: string[], token: string, onProgress: (p: Progress) => void): Promise<string[]> => {
  const progress = new Channel<Progress>();
  progress.onmessage = onProgress;
  return invoke<string[]>("terminal_drop", { machine: machineArg(machine), scope, paths, token, progress });
};

/** Stops the copy to a machine started as `token`. */
export const cancelDrop = (token: string): Promise<boolean> => invoke<boolean>("terminal_drop_cancel", { token });

/** What a copy stopped by its Cancel answers (desk-machine's `CANCELLED`). */
export const CANCELLED = "The copy was cancelled.";

/** An image pasted into terminal `scope` on `machine`, saved (and copied
 *  there for a machine), as its shell names it. */
export const terminalPasteImage = async (machine: MachineId, scope: string, image: Blob, token: string): Promise<string> => {
  if (!inApp) throw new Error("Pasting an image into a terminal needs the app.");
  const m = machineArg(machine);
  return tauriInvoke<string>("terminal_paste_image", new Uint8Array(await image.arrayBuffer()), {
    headers: {
      "x-desk-scope": encodeURIComponent(scope),
      "x-desk-type": encodeURIComponent(image.type),
      "x-desk-token": encodeURIComponent(token),
      ...(m ? { "x-desk-machine": encodeURIComponent(m) } : {}),
    },
  });
};
