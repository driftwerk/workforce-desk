// What each grid's sidebar row says, read once for every row: the rows are
// handed plain numbers, so whatever the badges read (every hub's floor,
// what's unread, the rooms' drafts) draws no row again unless what that row
// says changes.

import { useShallow } from "zustand/react/shallow";
import { useChat } from "../chat/store";
import { waitsOnYou, shownState } from "../floor/background";
import { useNeedCounts, useNeeds } from "../floor/store";
import { sessionKey } from "../hub/machines";
import { sessionItem, type ItemKey } from "../groups/model";
import { sessionKeyIn, terminalKeyIn } from "../grids/engine";
import type { Grid } from "../grids/model";
import { useGrids } from "../grids/store";
import { trackedIn } from "../grids/terminals";
import { useDesk } from "../hub/store";
import { inRoom, itemBadge } from "./badges";
import { Marks, useBadgeData, useRoomBadgeOf } from "./Marks";

export interface GridSummary {
  /** The things in its panes that wait on you: each asking or blocked,
   *  or with a need on the Floor, once. */
  needs: number;
  /** Its sessions and agents working. */
  working: number;
  /** Something new in its panes that isn't a need. */
  unread: boolean;
}

const NONE: GridSummary = { needs: 0, working: 0, unread: false };

const shown = (g: Grid | undefined) => g?.panes.filter((p) => p.rect) ?? [];

/** Every grid's summary, by id. */
export const useGridSummaries = (): Record<string, GridSummary> => {
  const ids = useGrids(useShallow((s) => s.order.filter((id) => s.grids[id])));
  const grids = useGrids(useShallow((s) => ids.map((id) => s.grids[id])));
  // Per grid, as plain values (so a session's event that changes none of
  // them draws nothing): the items its panes show, those waiting on you,
  // and how many work.
  const fromSessions = useDesk(
    useShallow((d) =>
      grids.flatMap((g) => {
        const items: string[] = [];
        const waiting: string[] = [];
        let working = 0;
        for (const p of shown(g)) {
          const c = p.content;
          if (c?.kind === "agent") items.push(`agent:${c.agent}`);
          const s = c?.kind === "session" ? d.sessions[sessionKeyIn(c)!] : c?.kind === "terminal" ? trackedIn(d.sessions, terminalKeyIn(c)) : null;
          if (!s) continue;
          const key = sessionItem(c?.kind === "session" ? sessionKeyIn(c)! : sessionKey(s));
          // A session shown twice (its pane and the terminal it runs in) is one.
          if (items.includes(key)) continue;
          items.push(key);
          const state = shownState(s);
          if (waitsOnYou({ state })) waiting.push(key);
          else if (state === "working" || state === "starting") working += 1;
        }
        return [items.join("\n"), waiting.join("\n"), working];
      }),
    ),
  );
  const agentsWorking = useChat(useShallow((s) => grids.map((g) => shown(g).filter((p) => p.content?.kind === "agent" && s.conversations[p.content.agent]?.working).length)));
  const needs = useNeedCounts();
  const data = useBadgeData();
  const roomBadge = useRoomBadgeOf();
  const allNeeds = useNeeds();
  const drafts = useDesk((s) => s.roomDrafts);
  const roomWaits = (room: string) => inRoom(allNeeds, room).length + (drafts[room] ?? []).filter((d) => d.state === "failed" || d.state === "stopped").length;
  const out: Record<string, GridSummary> = {};
  grids.forEach((g, i) => {
    if (!g) return;
    const items = ((fromSessions[i * 3] as string) || "").split("\n").filter(Boolean) as ItemKey[];
    const waiting = new Set(((fromSessions[i * 3 + 1] as string) || "").split("\n").filter(Boolean));
    for (const key of items) if (needs.has(key)) waiting.add(key);
    const rooms = [...new Set(shown(g).flatMap((p) => (p.content?.kind === "room" ? [p.content.room] : [])))];
    // A room's needs and failed answers wait on you, as its row counts them.
    const roomNeeds = rooms.reduce((n, r) => n + roomWaits(r), 0);
    const unread =
      items.some((key) => {
        const b = itemBadge(key, data);
        return b.dot || b.count > (needs.get(key) ?? 0);
      }) ||
      rooms.some((r) => {
        const b = roomBadge(r);
        return b.dot || b.count > roomWaits(r);
      });
    out[g.id] = { needs: waiting.size + roomNeeds, working: (fromSessions[i * 3 + 2] as number) + (agentsWorking[i] ?? 0), unread };
  });
  return out;
};

export const summaryOf = (all: Record<string, GridSummary>, id: string): GridSummary => all[id] ?? NONE;

/** The folded Grids section's mark: what waits on you in every grid,
 *  together, else a dot for something new. */
export function GridsMarks({ all }: { all: Record<string, GridSummary> }) {
  const list = Object.values(all);
  const needs = list.reduce((n, s) => n + s.needs, 0);
  return <Marks badge={{ count: needs, dot: needs === 0 && list.some((s) => s.unread) }} />;
}
