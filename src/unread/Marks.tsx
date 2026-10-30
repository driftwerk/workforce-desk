import { useMemo } from "react";
import type { FloorNeed } from "../floor/merge";
import { useFloor, useNeeds } from "../floor/store";
import { useDesk, type RoomDraft } from "../hub/store";
import { Badge, needsYou } from "../ui/Badge";
import { badgeOfRoom, inRoom, totalOf, type Badge as Marked, type BadgeData, type RoomMarker } from "./badges";
import { useUnread } from "./summary";

/** A row's mark: the number for you, else a dot for something new. */
export function Marks({ badge }: { badge: Marked }) {
  if (badge.count > 0) return <Badge count={badge.count} says={needsYou(badge.count)} />;
  if (badge.dot)
    return (
      <span className="side-dot">
        <span className="sr-only">unread</span>
      </span>
    );
  return null;
}

/** Whether `hub` has a Floor, which lists what its agents ask. */
export const useHasFloor = (): ((hub: string) => boolean) => {
  const hubs = useFloor((s) => s.hubs);
  return (hub: string) => hubs[hub]?.state === "ready";
};

/** What every item's badge is read from. */
export const useBadgeData = (): BadgeData => {
  const needs = useNeeds();
  const dms = useUnread((s) => s.dms);
  const sessions = useUnread((s) => s.local?.sessions);
  return useMemo(() => ({ needs, dms, sessions: sessions ?? [] }), [needs, dms, sessions]);
};

const NO_DRAFTS: RoomDraft[] = [];

/** A room's marks: its badge and whether someone is answering in it. */
export const useRoomMarker = (room: string): RoomMarker => {
  const summary = useUnread((s) => s.local?.rooms.find((r) => r.roomId === room));
  const drafts = useDesk((s) => s.roomDrafts[room]) ?? NO_DRAFTS;
  const needs = useNeeds();
  const hasFloor = useHasFloor();
  return badgeOfRoom(summary, drafts, inRoom(needs, room), hasFloor);
};

/** Everything unread, each item once. */
export const useTotal = (update = false): Marked => {
  const needs: readonly FloorNeed[] = useNeeds();
  const dms = useUnread((s) => s.dms);
  const local = useUnread((s) => s.local);
  const drafts = useDesk((s) => s.roomDrafts);
  return useMemo(() => totalOf({ needs, dms, local, drafts, update }), [needs, dms, local, drafts, update]);
};
