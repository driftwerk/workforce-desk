import { useDesk } from "../hub/store";
import type { Room } from "../hub/types";
import { Confirm } from "../ui/Confirm";
import { closeRoom } from "./engine";
import { forgetRoom } from "./order";

/** Deletes a room: each member's hub is told first, then this computer's. */
export async function deleteRoom(id: string): Promise<void> {
  const { hub, rooms } = useDesk.getState();
  if (!hub) throw new Error("Desk isn't connected to its hub.");
  const room = rooms[id];
  if (room) await closeRoom(room);
  await hub.deleteRoom(id);
  useDesk.setState((s) => {
    const { [id]: _gone, ...rest } = s.rooms;
    return { rooms: rest, activeRoom: s.activeRoom === id ? null : s.activeRoom };
  });
  forgetRoom(id);
}

/** Asks before deleting `room`. */
export function DeleteRoom({ room, onClose, onDeleted }: { room: Room; onClose: () => void; onDeleted?: () => void }) {
  return (
    <Confirm
      title={`Delete “${room.name}”?`}
      action="Delete room"
      onConfirm={async () => {
        await deleteRoom(room.id);
        onDeleted?.();
      }}
      onClose={onClose}
    >
      <p className="muted">Its messages are deleted for everyone in it. The agents in it stay in your crew.</p>
    </Confirm>
  );
}
