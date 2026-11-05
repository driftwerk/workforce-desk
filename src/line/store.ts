import { create } from "zustand";
import { keyOf, LOCAL, machineOf, splitKey, type MachineId } from "../hub/machines";
import { engineListeners, hubOf, type EngineEvent } from "../hub/store";
import type { LineAsked, LineMessage } from "../hub/types";
import { plainError } from "../ui/plainError";
import { merged, onThread } from "./rows";

interface LineState {
  /** Each loaded session's thread, oldest first, by session key (see
   *  `keyOf`): a line is on its session's own engine. */
  threads: Record<string, LineMessage[]>;
  /** Sessions whose thread couldn't be read, and why, by key. */
  problems: Record<string, string>;
  /** Where each question heard of since the Floor was read now stands:
   *  answered or dismissed anywhere, it leaves the Floor at once; by its
   *  key on its engine. */
  asked: Record<string, LineAsked>;
  /** Reads session `key`'s thread from its engine. */
  load: (key: string) => Promise<void>;
  /** A message `machine`'s engine announced (or answered with). */
  heard: (m: LineMessage, removed?: boolean, machine?: MachineId) => void;
}

/** How many messages were heard: a read that began before the last one
 *  may not have it. */
let heardCount = 0;

export const useLine = create<LineState>((set) => ({
  threads: {},
  problems: {},
  asked: {},
  load: async (sessionId) => {
    const on = splitKey(sessionId);
    // A message heard while the thread was being read may be newer than
    // what the read says: the read is then made again (a few times at
    // most), never laid over it.
    for (let tries = 0; tries < 3; tries++) {
      const hub = hubOf(on.machine);
      if (!hub) return;
      const was = heardCount;
      try {
        const thread = await hub.lineThread(on.id);
        if (heardCount !== was && tries < 2) continue;
        set((s) => ({ threads: { ...s.threads, [sessionId]: thread }, problems: withoutKey(s.problems, sessionId) }));
      } catch (e) {
        set((s) => ({ problems: { ...s.problems, [sessionId]: plainError(e) } }));
      }
      return;
    }
  },
  heard: (m, removed = false, machine = LOCAL) => {
    heardCount++;
    set((s) => {
      let threads = s.threads;
      for (const [key, list] of Object.entries(s.threads)) {
        const on = splitKey(key);
        if (on.machine === machine && onThread(m, on.id)) threads = { ...threads, [key]: merged(list, m, removed) };
      }
      const at = keyOf(machine, m.id);
      const asked = m.kind === "ask" && m.asked && s.asked[at] !== m.asked ? { ...s.asked, [at]: m.asked } : s.asked;
      return threads === s.threads && asked === s.asked ? s : { threads, asked };
    });
  },
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

const onEvent = (e: EngineEvent) => {
  if (e.type === "line") useLine.getState().heard(e.message, e.removed, machineOf(e));
};
engineListeners.add(onEvent);
