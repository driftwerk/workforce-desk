import { useDesk, type RoomDraft } from "../hub/store";
import type { Room } from "../hub/types";
import { MemberMark } from "../rooms/MemberMark";
import { useAuthor } from "../rooms/names";
import { Marks, useRoomMarker } from "./Marks";

const NO_DRAFTS: RoomDraft[] = [];

/** A room row's marks: someone answering (a ringed mark), and its badge. */
export function RoomMarks({ room }: { room: Room }) {
  const marker = useRoomMarker(room.id);
  const drafts = useDesk((s) => s.roomDrafts[room.id]) ?? NO_DRAFTS;
  const author = useAuthor();
  const answering = marker.working ? drafts.find((d) => d.state === "live" || d.state === "stalled")?.member : undefined;
  return (
    <>
      {answering && <MemberMark member={answering} name={author(answering).name} size="xs" state="working" />}
      <Marks badge={marker} />
    </>
  );
}
