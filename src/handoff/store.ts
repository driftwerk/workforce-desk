// Continuing a session in another engine (session memory §5, SMD3): one way
// in from every place that offers it (the session card, its Memory tab, a
// pane's menu, the sidebar's, a Floor tile's), one dialog (HandoffDialog),
// and where each session's work came from and went, as its card shows it.

import { create } from "zustand";
import { useDesk } from "../hub/store";
import { HubError } from "../hub/client";
import type { Engine, LineageView } from "../hub/types";

/** A handoff asked for: of this computer's session `id`, to `engine` when
 *  the way in chose it, or handing its work back to where it came from. */
export interface HandoffAsk {
  id: string;
  engine?: Engine;
  back?: boolean;
}

/** What a handoff told the person, kept for the card of the session it went
 *  on in: "Handed over: …", and what didn't follow the work. */
export interface Told {
  said: string;
  notes: string[];
}

interface HandoffState {
  asking: HandoffAsk | null;
  open: (ask: HandoffAsk) => void;
  close: () => void;
  /** Each session's lineage once read; null: none, or a hub that keeps none. */
  lineage: Record<string, LineageView | null>;
  /** What each handoff made this run said, by the session it went on in. */
  told: Record<string, Told>;
  /** Reads session `id`'s lineage (never its brief: no model call). */
  loadLineage: (id: string) => Promise<void>;
  /** Notes what a handoff said, and reads both sessions' lineage again. */
  handed: (from: string, to: string, told: Told) => void;
}

export const useHandoff = create<HandoffState>((set, get) => ({
  asking: null,
  open: (asking) => set({ asking }),
  close: () => set({ asking: null }),
  lineage: {},
  told: {},
  loadLineage: async (id) => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    try {
      const l = await hub.lineage(id);
      // A work of one session has nothing to show.
      set((s) => ({ lineage: { ...s.lineage, [id]: l.from || l.handedTo ? l : null } }));
    } catch (e) {
      // An older hub keeps no lineage: nothing to show, nothing to say.
      if (e instanceof HubError && (e.status === 404 || e.status === 405)) set((s) => ({ lineage: { ...s.lineage, [id]: null } }));
    }
  },
  handed: (from, to, told) => {
    set((s) => ({ told: { ...s.told, [to]: told } }));
    void get().loadLineage(from);
    void get().loadLineage(to);
  },
}));

/** Opens the dialog for this computer's session `id`. */
export const askHandoff = (ask: HandoffAsk): void => useHandoff.getState().open(ask);
