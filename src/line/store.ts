import { create } from "zustand";
import { deskListeners, useDesk } from "../hub/store";
import type { DeskEvent, LineMessage } from "../hub/types";
import { merged, onThread } from "./rows";

interface LineState {
  /** Each loaded session's thread, oldest first. */
  threads: Record<string, LineMessage[]>;
  /** Sessions whose thread couldn't be read, and why. */
  problems: Record<string, string>;
  /** Reads `sessionId`'s thread from the hub. */
  load: (sessionId: string) => Promise<void>;
  /** A message the hub announced (or answered with). */
  heard: (m: LineMessage, removed?: boolean) => void;
}

export const useLine = create<LineState>((set) => ({
  threads: {},
  problems: {},
  load: async (sessionId) => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    try {
      const thread = await hub.lineThread(sessionId);
      set((s) => ({ threads: { ...s.threads, [sessionId]: thread }, problems: withoutKey(s.problems, sessionId) }));
    } catch (e) {
      set((s) => ({ problems: { ...s.problems, [sessionId]: e instanceof Error ? e.message : String(e) } }));
    }
  },
  heard: (m, removed = false) =>
    set((s) => {
      let threads = s.threads;
      for (const [id, list] of Object.entries(s.threads)) {
        if (onThread(m, id)) threads = { ...threads, [id]: merged(list, m, removed) };
      }
      return threads === s.threads ? s : { threads };
    }),
}));

const withoutKey = <T>(r: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in r)) return r;
  const { [key]: _, ...rest } = r;
  return rest;
};

/** The message `id` wherever a loaded thread has it. */
export const messageIn = (threads: Record<string, LineMessage[]>, id: string): LineMessage | undefined => {
  for (const list of Object.values(threads)) {
    const m = list.find((x) => x.id === id);
    if (m) return m;
  }
  return undefined;
};

const onEvent = (e: DeskEvent) => {
  if (e.type === "line") useLine.getState().heard(e.message, e.removed);
};
deskListeners.add(onEvent);
