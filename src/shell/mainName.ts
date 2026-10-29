import { useChat } from "../chat/store";
import { agentKey } from "../chat/types";
import { shownGrid, useGrids } from "../grids/store";
import { useDesk } from "../hub/store";

/** What the main area shows, as the breadcrumb back to it says: the room or
 *  agent open in Rooms, the grid, or the Floor. */
export function useMainName(): string {
  const view = useDesk((s) => s.view);
  const room = useDesk((s) => (s.activeRoom ? s.rooms[s.activeRoom]?.name : undefined));
  const agent = useChat((s) => (s.activeAgent ? s.roster.find((a) => agentKey(a) === s.activeAgent)?.name : undefined));
  const grid = useGrids((s) => shownGrid(s)?.name);
  if (view === "floor") return "Floor";
  if (view === "grids") return grid ?? "Grids";
  return room ?? agent ?? "Rooms";
}

/** Which thing the main area shows: it changing (a room or view picked in
 *  the sidebar) brings the main area back from behind a focused panel. */
export function useMainKey(): string {
  const view = useDesk((s) => s.view);
  const room = useDesk((s) => s.activeRoom);
  const dm = useChat((s) => s.activeAgent);
  const grid = useGrids((s) => shownGrid(s)?.id);
  if (view === "rooms") return room ? `room:${room}` : `dm:${dm ?? ""}`;
  return view === "grids" ? `grid:${grid ?? ""}` : view;
}
