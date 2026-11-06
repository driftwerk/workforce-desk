// Files dropped on a terminal's pane, and an image pasted into one: the
// terminal is given their paths, as Ghostty gives a dropped file's (see
// paths.ts), and nothing else: the person presses Enter. On a machine the
// files are copied there first, and the pane says so while they go.

import { formatSize } from "../attachments/kinds";
import { LOCAL, type MachineId } from "../hub/machines";
import { pathsLine } from "./paths";
import { CANCELLED, cancelDrop, terminalDrop, terminalPasteImage, type Progress } from "./native";

/** What a terminal's pane says of a drop, under its terminal: a copy to a
 *  machine on its way, or why one couldn't be given. */
export type DropNote = { kind: "copying"; text: string; cancel?: () => void } | { kind: "error"; text: string };

/** The note while `count` files go to machine `name`. */
export const copyingText = (name: string, count: number, p?: Progress): string => {
  const what = count === 1 ? "the file" : `${count} files`;
  const far = p && p.total > 0 ? ` · ${formatSize(p.sent)} of ${formatSize(p.total)}` : "";
  return `Copying ${what} to ${name}…${far}`;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface Target {
  machine: MachineId;
  /** The machine's name, for the note. */
  machineName: string;
  /** The terminal's id: a session's, or a grid terminal's. */
  scope: string;
  /** Types `text` into the terminal, as a paste. */
  write: (text: string) => void;
  /** Whether the terminal is there to be typed into (its socket open). */
  running: () => boolean;
  note: (n: DropNote | null) => void;
}

/** Why nothing was given: the terminal isn't running, so a drop would be
 *  copied for nothing and lost. */
export const notRunning = "This terminal isn’t running, so nothing was given to it.";

/** A copy's Cancel, and how its end is told: cancelled, the note just goes. */
const cancellable = (cancel: (token: string) => Promise<unknown>) => {
  const token = crypto.randomUUID();
  let cancelled = false;
  return {
    token,
    cancel: () => {
      cancelled = true;
      void cancel(token).catch(() => undefined);
    },
    failed: (t: Target, e: unknown) => t.note(cancelled || message(e) === CANCELLED ? null : { kind: "error", text: message(e) }),
  };
};

/** Gives the terminal the dropped `paths`, as its shell names them. */
export const giveDropped = async (
  t: Target,
  paths: string[],
  drop: typeof terminalDrop = terminalDrop,
  cancel: (token: string) => Promise<unknown> = cancelDrop,
): Promise<void> => {
  if (!t.running()) return t.note({ kind: "error", text: notRunning });
  const remote = t.machine !== LOCAL;
  const c = cancellable(cancel);
  const copying = (p?: Progress) => t.note({ kind: "copying", text: copyingText(t.machineName, paths.length, p), cancel: c.cancel });
  if (remote) copying();
  try {
    const named = await drop(t.machine, t.scope, paths, c.token, (p) => {
      if (remote) copying(p);
    });
    if (!t.running()) return t.note({ kind: "error", text: notRunning });
    t.write(pathsLine(named));
    t.note(null);
  } catch (e) {
    c.failed(t, e);
  }
};

/** The image on the clipboard of a paste, when it carries one and no text:
 *  a paste with text stays the terminal's own. */
export const clipboardImage = (data: DataTransfer | null): File | null => {
  if (!data) return null;
  if ([...data.types].includes("text/plain")) return null;
  for (const item of [...(data.items ?? [])]) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return [...(data.files ?? [])].find((f) => f.type.startsWith("image/")) ?? null;
};

/** Saves a pasted `image` and gives the terminal its path. */
export const givePasted = async (
  t: Target,
  image: Blob,
  save: typeof terminalPasteImage = terminalPasteImage,
  cancel: (token: string) => Promise<unknown> = cancelDrop,
): Promise<void> => {
  if (!t.running()) return t.note({ kind: "error", text: notRunning });
  const remote = t.machine !== LOCAL;
  const c = cancellable(cancel);
  if (remote) t.note({ kind: "copying", text: `Copying the image to ${t.machineName}…`, cancel: c.cancel });
  try {
    const path = await save(t.machine, t.scope, image, c.token);
    if (!t.running()) return t.note({ kind: "error", text: notRunning });
    t.write(pathsLine([path]));
    t.note(null);
  } catch (e) {
    c.failed(t, e);
  }
};
