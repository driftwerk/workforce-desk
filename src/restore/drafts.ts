// What you've typed and not sent or saved — a DM's, a room's or a thread's
// message, and changes to an agent's files — kept under `draft.*` with the
// rest of what Desk restores, so a crash, a quit or a hub restart never
// loses it. A message's draft goes once it's sent.

import { useCallback, useEffect, useState } from "react";
import { useDrafts, isDirty, type Draft } from "../crew/files";
import { deskState } from "./boot";
import type { DeskStateStore } from "./store";

export const draftKey = {
  dm: (agent: string) => `draft.dm.${agent}`,
  /** A room's message, or a reply in one of its threads. */
  room: (room: string, thread: string | null = null) => (thread ? `draft.thread.${room}.${thread}` : `draft.room.${room}`),
  /** An agent's file (`hub/agent`, `SOUL.md`). */
  file: (agent: string, file: string) => `draft.file.${agent}/${file}`,
};

/** A message draft as kept: its text, or "" for none. */
export const readDraft = (key: string | null, store: DeskStateStore = deskState): string => {
  const v = key ? store.get(key) : undefined;
  return typeof v === "string" ? v : "";
};

/** Keeps `text` as the draft under `key` (debounced); none when it's empty. */
export const keepDraft = (key: string, text: string, store: DeskStateStore = deskState): void => {
  if (text) store.setSoon(key, text);
  else store.remove(key);
};

/** A composer's text, kept as the draft under `key` (none: not kept). The
 *  text follows the key: each conversation has its own. */
export function useDraft(key: string | null, store: DeskStateStore = deskState): [string, (text: string) => void] {
  const [state, setState] = useState(() => ({ key, text: readDraft(key, store) }));
  // Another conversation: its own draft (set during render, so no frame
  // shows the last one's text).
  const current = state.key === key ? state : { key, text: readDraft(key, store) };
  if (current !== state) setState(current);
  useEffect(() => {
    if (!key) return;
    return store.watch(key, (v) => setState({ key, text: typeof v === "string" ? v : "" }));
  }, [key, store]);
  const set = useCallback(
    (text: string) => {
      setState({ key, text });
      if (key) keepDraft(key, text, store);
    },
    [key, store],
  );
  return [current.text, set];
}

/** A file's unsaved changes as kept. */
interface KeptFile {
  text: string;
  /** What the agent had when the changes were made. */
  saved: string;
}

/** A file just read from the hub, with any changes kept from before put
 *  back over it (they're the person's, so they win). */
export const withKeptChanges = (d: Draft, agent: string, file: string, store: DeskStateStore = deskState): Draft => {
  const kept = store.get(draftKey.file(agent, file)) as Partial<KeptFile> | undefined;
  return kept && typeof kept.text === "string" && kept.text !== d.saved ? { ...d, text: kept.text, justSaved: false } : d;
};

/** Keeps every file's unsaved changes, and forgets them once saved or
 *  discarded. */
export function keepFileDrafts(store: DeskStateStore = deskState): () => void {
  return useDrafts.subscribe((s, before) => {
    for (const k of new Set([...Object.keys(s.drafts), ...Object.keys(before.drafts)])) {
      const now = s.drafts[k];
      if (now === before.drafts[k]) continue;
      const slash = k.lastIndexOf("/");
      const key = draftKey.file(k.slice(0, slash), k.slice(slash + 1));
      if (now && isDirty(now)) store.setSoon(key, { text: now.text, saved: now.saved } satisfies KeptFile);
      else store.remove(key);
    }
  });
}
