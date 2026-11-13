// The order the Go to keys (⌘1 to ⌘9) take the sidebar's items in, and the
// number the lit row shows.

import { useShallow } from "zustand/react/shallow";
import { arrangedBoards, useBoardOrder } from "../board/order";
import { useBoard } from "../board/store";
import { useGrids } from "../grids/store";
import { useDesk } from "../hub/store";
import { arranged, useRoomOrder } from "../rooms/order";
import { useSettings } from "../settings/store";
import { shortcutLabel, withDigit } from "../shortcuts/keys";
import { useSections, type SectionId } from "./SideSection";

export type Jump = { kind: "dashboard" } | { kind: "grid" | "room" | "board"; id: string };

/** The items the Go to keys reach, in order, as the sidebar shows them. */
export const jumps = (lists: { grids: readonly string[]; rooms: readonly string[]; boards: readonly string[] }, closed: Partial<Record<SectionId, boolean>>): Jump[] =>
  [
    { kind: "dashboard" } as Jump,
    ...(closed.grids ? [] : lists.grids.map((id): Jump => ({ kind: "grid", id }))),
    ...(closed.rooms ? [] : lists.rooms.map((id): Jump => ({ kind: "room", id }))),
    ...(closed.boards ? [] : lists.boards.map((id): Jump => ({ kind: "board", id }))),
  ].slice(0, 9);

export const gridIds = (s: ReturnType<typeof useGrids.getState>) => s.order.filter((id) => s.grids[id]);
export const roomIds = (rooms: Parameters<typeof arranged>[0], order: readonly string[]) => arranged(rooms, order).map((r) => r.id);
export const boardIds = (s: Pick<ReturnType<typeof useBoard.getState>, "supported" | "boards">, order: readonly string[]): string[] =>
  s.supported === false ? [] : arrangedBoards(s.boards, order).map((b) => b.id);

/** The lit row's number, as "⌘2": drawn only on that row, so only it reads
 *  what comes before it. */
export function JumpKey({ kind, id }: { kind: "grid" | "room" | "board"; id: string }) {
  const keys = useSettings((s) => s.keys.goTo);
  const closed = useSections((s) => s.closed);
  const grids = useGrids(useShallow(gridIds));
  const roomOrder = useRoomOrder((s) => s.order);
  const rooms = useDesk(useShallow((s) => roomIds(s.rooms, roomOrder)));
  const boardOrder = useBoardOrder((s) => s.order);
  const boards = useBoard(useShallow((s) => boardIds(s, boardOrder)));
  const at = jumps({ grids, rooms, boards }, closed).findIndex((j) => j.kind === kind && j.id === id);
  if (at < 0 || !keys) return null;
  const label = shortcutLabel(withDigit(keys, at + 1));
  return (
    <kbd className="gi-kbd" aria-hidden="true" title={`Go here with ${label}`}>
      {label}
    </kbd>
  );
}
