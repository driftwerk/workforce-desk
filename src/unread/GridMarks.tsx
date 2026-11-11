import { sessionItem } from "../groups/model";
import type { Grid } from "../grids/model";
import { badgeOfGrid, itemBadge } from "./badges";
import { Marks, useBadgeData, useRoomsBadge } from "./Marks";
import { sessionKeyIn } from "../grids/engine";

/** A grid row's badge: what's unread in the sessions, DMs and rooms its
 *  panes show. */
export function GridMarks({ grid }: { grid: Grid }) {
  const data = useBadgeData();
  const items = grid.panes.flatMap((p) =>
    p.content?.kind === "session"
      ? [sessionItem(sessionKeyIn(p.content)!)]
      : p.content?.kind === "agent"
        ? [`agent:${p.content.agent}`]
        : [],
  );
  const rooms = useRoomsBadge(grid.panes.flatMap((p) => (p.content?.kind === "room" ? [p.content.room] : [])));
  return <Marks badge={badgeOfGrid([...items.map((key) => itemBadge(key, data)), rooms])} />;
}
