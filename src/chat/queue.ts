// What you send an agent while it's working: held in a queue under the
// composer and sent as its next turn once this one ends, the way Claude Code
// does it. Everything queued goes together, in the order it was typed, as one
// message. Stopping the agent pauses the queue, so nothing goes on its own
// right after a Stop; a queue put back after a reload waits paused too, since
// Desk can't tell whether the turn it waited for has ended. Kept with the
// drafts, so a reload or a crash never loses it: a message stays in the queue
// until the hub has taken it, and one sent when the window went is put back.

import { draftKey } from "../restore/drafts";
import { deskState } from "../restore/boot";
import type { DeskStateStore } from "../restore/store";
import type { Attachment } from "./types";

/** One message waiting in a DM's queue, its files uploaded already. */
export interface Queued {
  id: string;
  text: string;
  attachments?: Attachment[];
  /** On its way: the ticket of the send it went in, until the hub takes it
   *  (and it leaves the queue) or it's put back. Kept, so another window
   *  doesn't send it too. */
  sending?: string;
}

/** A DM's queue. */
export interface Queue {
  items: Queued[];
  /** Held until you send it on: after a Stop, or put back after a reload. */
  paused: boolean;
  /** The message being edited here: nothing goes until it's saved. */
  editing?: string;
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
  ((v as Queued).attachments === undefined || Array.isArray((v as Queued).attachments)) &&
  ((v as Queued).sending === undefined || typeof (v as Queued).sending === "string");

/** The messages a kept queue holds, as kept. */
export const keptItems = (v: unknown): Queued[] => {
  const items = (v as { items?: unknown } | null | undefined)?.items;
  return Array.isArray(items) ? items.filter(isQueued) : [];
};

/** The queue kept for agent `key` as a window opening puts it back: paused,
 *  and with what was on its way when a window went back in it, since
 *  whether the hub took it can't be known. None if nothing's kept. */
export const readQueue = (key: string, store: DeskStateStore = deskState): Queue | null => {
  const items = keptItems(store.get(draftKey.queue(key))).map(({ sending: _sent, ...i }) => i);
  return items.length ? { items, paused: true } : null;
};

/** What's kept in Desk's file (read late) that `q` lacks, put in front of
 *  it, paused: nothing typed is dropped for being read after the window
 *  opened. */
export const withKept = (q: Queue, kept: Queued[]): Queue => {
  const have = new Set(q.items.map((i) => i.id));
  const missing = kept.filter((i) => !have.has(i.id)).map(({ sending: _sent, ...i }) => i);
  return missing.length ? { ...q, items: [...missing, ...q.items], paused: true } : q;
};

/** Keeps agent `key`'s queue, at once (another window reads it to know what
 *  this one has sent); none once it's empty. */
export const keepQueue = (key: string, q: Queue, store: DeskStateStore = deskState): void => {
  if (q.items.length) store.set(draftKey.queue(key), { items: q.items });
  else store.remove(draftKey.queue(key));
};

/** How long a queue the hub held back as busy (a turn Desk can't see is
 *  running) waits before it's offered again, after `times` in a row. */
export const heldRetryMs = (times: number): number => Math.min(3000 * 2 ** Math.max(0, times - 1), 60_000);
