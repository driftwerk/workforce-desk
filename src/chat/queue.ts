// What you send an agent while it's working: held in a queue under the
// composer and sent as its next turn once this one ends, the way Claude Code
// does it. Everything queued goes together, in the order it was typed, as one
// message. Stopping the agent pauses the queue, so nothing goes on its own
// right after a Stop; a queue put back after a reload waits paused too, since
// Desk can't tell whether the turn it waited for has ended. Kept with the
// drafts, so a reload or a crash never loses it.

import { draftKey } from "../restore/drafts";
import { deskState } from "../restore/boot";
import type { DeskStateStore } from "../restore/store";
import type { Attachment } from "./types";

/** One message waiting in a DM's queue, its files uploaded already. */
export interface Queued {
  id: string;
  text: string;
  attachments?: Attachment[];
}

/** A DM's queue. */
export interface Queue {
  items: Queued[];
  /** Held until you send it on: after a Stop, or put back after a reload. */
  paused: boolean;
}

export const emptyQueue = (): Queue => ({ items: [], paused: false });

/** The one message everything queued goes as: the texts in order, a blank
 *  line between, with every file. */
export const merged = (items: Queued[]): { text: string; attachments: Attachment[] } => ({
  text: items
    .map((i) => i.text.trim())
    .filter(Boolean)
    .join("\n\n"),
  attachments: items.flatMap((i) => i.attachments ?? []),
});

const isQueued = (v: unknown): v is Queued =>
  !!v &&
  typeof v === "object" &&
  typeof (v as Queued).id === "string" &&
  typeof (v as Queued).text === "string" &&
  ((v as Queued).attachments === undefined || Array.isArray((v as Queued).attachments));

/** The queue kept for agent `key`, paused, or none. */
export const readQueue = (key: string, store: DeskStateStore = deskState): Queue | null => {
  const kept = store.get(draftKey.queue(key)) as { items?: unknown } | undefined;
  const items = Array.isArray(kept?.items) ? kept.items.filter(isQueued) : [];
  return items.length ? { items, paused: true } : null;
};

/** Keeps agent `key`'s queue; none once it's empty. */
export const keepQueue = (key: string, q: Queue, store: DeskStateStore = deskState): void => {
  if (q.items.length) store.setSoon(draftKey.queue(key), { items: q.items });
  else store.remove(draftKey.queue(key));
};
