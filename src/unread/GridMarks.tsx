import { sessionItem } from "../groups/model";
import type { Grid } from "../grids/model";
import { useGrids } from "../grids/store";
import { useShallow } from "zustand/react/shallow";
import { badgeOfGrid, itemBadge, type Badge } from "./badges";
import { Marks, useBadgeData, useRoomsBadge } from "./Marks";
import { sessionKeyIn } from "../grids/engine";

/** The sidebar items and rooms grids' panes show. */
const shownIn = (grids: readonly Grid[]): { items: string[]; rooms: string[] } => {
  const panes = grids.flatMap((g) => g.panes);
  return {
    items: panes.flatMap((p) =>
      p.content?.kind === "session" ? [sessionItem(sessionKeyIn(p.content)!)] : p.content?.kind === "agent" ? [`agent:${p.content.agent}`] : [],
    ),
    rooms: panes.flatMap((p) => (p.content?.kind === "room" ? [p.content.room] : [])),
  };
};

/** What's for you in the sessions, DMs and rooms grids' panes show. */
export const useGridsBadge = (grids: readonly Grid[]): Badge => {
  const data = useBadgeData();
  const { items, rooms } = shownIn(grids);
  const inRooms = useRoomsBadge(rooms);
  return badgeOfGrid([...items.map((key) => itemBadge(key, data)), inRooms]);
};

/** The closed Grids section's mark: what's for you in every grid, together. */
export function GridsMarks() {
  const grids = useGrids(useShallow((s) => s.order.flatMap((id) => s.grids[id] ?? [])));
  return <Marks badge={useGridsBadge(grids)} />;
}
