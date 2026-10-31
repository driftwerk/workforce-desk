import { sessionItem } from "../groups/model";
import type { Grid } from "../grids/model";
import { badgeOfGrid, itemBadge } from "./badges";
import { Marks, useBadgeData } from "./Marks";

/** A grid row's badge: what's unread in the sessions and DMs its panes show. */
export function GridMarks({ grid }: { grid: Grid }) {
  const data = useBadgeData();
  const items = grid.panes.flatMap((p) =>
    p.content?.kind === "session"
      ? [sessionItem(p.content.sessionId)]
      : p.content?.kind === "agent"
        ? [`agent:${p.content.agent}`]
        : [],
  );
  return <Marks badge={badgeOfGrid(items.map((key) => itemBadge(key, data)))} />;
}
