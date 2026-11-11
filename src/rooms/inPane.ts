// A room shown in a grid's pane rather than in Rooms: its own scroll (not the
// one Rooms keeps for the room), and a thread opened from it opens where
// threads show, in Rooms, as the pane has no column beside it.

import { createContext, useContext } from "react";
import { useUi } from "../shell/ui";

export interface RoomPane {
  /** Opens thread `thread` of room `room`. */
  openThread: (room: string, thread: string) => void;
}

export const RoomPaneContext = createContext<RoomPane | null>(null);

/** Whether this room is shown in a pane. */
export const useInPane = (): boolean => useContext(RoomPaneContext) !== null;

/** How a thread opens from here: beside the room in Rooms, or from a pane,
 *  as the pane says. */
export const useThreadOpener = (): ((room: string, thread: string) => void) =>
  useContext(RoomPaneContext)?.openThread ?? ((room, thread) => useUi.getState().setRoomThread(room, thread));
