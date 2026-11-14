// The boss a group's grant names on another hub (RBD1c): Allan on Driftwerk,
// made the boss of the person's Acme group from its Boss sheet. The person
// hands one of the group's sessions to him as to this computer's own
// overseer ("Hand to Allan"); the session's engine charges it to the boss
// its group's live grant names. The page knows him by his name and his
// party id (`<hub>/<agent>`), as `boss_status` says them, never a token.

import { create } from "zustand";
import { useEffect } from "react";
import { useChat } from "../chat/store";
import { groupOf, sessionItem, UNGROUPED, type Layout } from "../groups/model";
import { remoteBosses, type RemoteBoss } from "../groups/remoteBoss";
import { useLayout } from "../groups/store";
import { sessionKey, type MachineId } from "../hub/machines";
import type { Boss } from "./charge";

/** How long a group's boss, as read, is taken as still so. */
const FRESH_MS = 60_000;

interface GrantBossState {
  /** Each group's boss on another hub, as last read: null where it has
   *  none, or where it doesn't run sessions now (paused, stopping). */
  byGroup: Record<string, Boss | null>;
  /** When each was read. */
  readAt: Record<string, number>;
  /** What `boss_status` said of `group` (the Boss sheet reads it too). */
  heard: (group: string, status: RemoteBoss | null) => void;
  /** Reads `group`'s boss again unless it was read just now. */
  ensure: (group: string) => void;
}

/** The boss a grant's status names, as sessions are handed to it: none
 *  while it is paused or being stopped (its engines let go of what it
 *  runs). Its name is the roster's when the paired hub's roster has it. */
export const bossOfStatus = (s: RemoteBoss | null, rosterName?: string): Boss | null => {
  if (!s || s.paused || s.pausing || s.stopping) return null;
  return { id: s.party, name: rosterName ?? s.agent, level: s.choice.level };
};

const nameOf = (s: RemoteBoss | null): string | undefined =>
  s ? useChat.getState().roster.find((a) => a.hubId === s.hub && a.id === s.agent)?.name : undefined;

const reading = new Set<string>();

export const useGrantBosses = create<GrantBossState>((set, get) => ({
  byGroup: {},
  readAt: {},
  heard: (group, status) =>
    set((s) => ({ byGroup: { ...s.byGroup, [group]: bossOfStatus(status, nameOf(status)) }, readAt: { ...s.readAt, [group]: Date.now() } })),
  ensure: (group) => {
    if (group === UNGROUPED || reading.has(group)) return;
    if (Date.now() - (get().readAt[group] ?? 0) < FRESH_MS) return;
    reading.add(group);
    remoteBosses
      .status(group)
      .then((s) => get().heard(group, s))
      // Kept as last read; read again next time it's asked for.
      .catch(() => {})
      .finally(() => reading.delete(group));
  },
}));

type Placed = { id: string; machine?: MachineId | null };

/** The group `s` is in, as the sidebar has it. */
export const groupOfSession = (layout: Layout, s: Placed): string => groupOf(layout, sessionItem(sessionKey(s)));

/** The boss `s`'s group's grant names, as last read; none when it has none. */
export const grantBossOf = (layout: Layout, s: Placed): Boss | null => {
  const g = groupOfSession(layout, s);
  return g === UNGROUPED ? null : (useGrantBosses.getState().byGroup[g] ?? null);
};

/** The same, kept current in a component, and read when it may have changed. */
export const useGrantBossOf = (s: Placed | null | undefined): Boss | null => {
  const layout = useLayout();
  const group = s ? groupOfSession(layout, s) : UNGROUPED;
  const boss = useGrantBosses((st) => (group === UNGROUPED ? null : (st.byGroup[group] ?? null)));
  useEffect(() => {
    useGrantBosses.getState().ensure(group);
  }, [group]);
  return boss;
};

/** Whether `boss` is one on another hub (its id `<hub>/<agent>`). */
export const isServed = (boss: Boss | null | undefined): boolean => !!boss && boss.id.includes("/");
