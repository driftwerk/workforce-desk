import { create } from "zustand";

/** What a session's line panel shows when it is up: its open questions, or
 *  the whole history (Messages with Desk…). */
export type PanelMode = "questions" | "history";

export interface PanelState {
  /** Up (shown under the terminal) and how, per session; down when absent. */
  shown: Record<string, PanelMode>;
  /** The height you dragged it to, per session, in pixels. */
  heights: Record<string, number>;
  show: (sessionId: string, mode?: PanelMode) => void;
  hide: (sessionId: string) => void;
  setHeight: (sessionId: string, px: number) => void;
}

/** How tall an opened panel is until you drag it. */
export const PANEL_HEIGHT = 260;
/** It never goes shorter than this. */
export const PANEL_MIN = 120;

const KEY = "desk.linePanel";

interface Kept {
  shown: Record<string, PanelMode>;
  heights: Record<string, number>;
}

/** What this computer remembers of each session's panel; nothing when its
 *  storage can't be read (a private window, blocked site data). */
const read = (): Kept => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Kept>;
    const shown = Object.fromEntries(Object.entries(v.shown ?? {}).filter(([, m]) => m === "questions"));
    const heights = Object.fromEntries(Object.entries(v.heights ?? {}).filter(([, h]) => typeof h === "number" && h >= PANEL_MIN));
    return { shown, heights };
  } catch {
    return { shown: {}, heights: {} };
  }
};

/** Kept for next time; only the questions view is, the history is a look
 *  you open from the menu. */
const write = (s: Kept) => {
  try {
    const shown = Object.fromEntries(Object.entries(s.shown).filter(([, m]) => m === "questions"));
    localStorage.setItem(KEY, JSON.stringify({ shown, heights: s.heights }));
  } catch {
    // Not kept: it opens collapsed next time.
  }
};

const without = (r: Record<string, PanelMode>, key: string): Record<string, PanelMode> => {
  if (!(key in r)) return r;
  const { [key]: _, ...rest } = r;
  return rest;
};

export const useLinePanel = create<PanelState>((set, get) => ({
  ...read(),
  show: (sessionId, mode = "questions") => {
    set((s) => ({ shown: { ...s.shown, [sessionId]: mode } }));
    write(get());
  },
  hide: (sessionId) => {
    set((s) => ({ shown: without(s.shown, sessionId) }));
    write(get());
  },
  setHeight: (sessionId, px) => {
    set((s) => ({ heights: { ...s.heights, [sessionId]: Math.max(PANEL_MIN, Math.round(px)) } }));
    write(get());
  },
}));
