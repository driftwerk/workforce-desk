import { useMemo } from "react";
import type { FloorNeed } from "../floor/merge";
import { useFloor, useNeeds } from "../floor/store";
import { useDesk, type RoomDraft } from "../hub/store";
import { Badge, needsYou } from "../ui/Badge";
import { badgeOfRoom, inRoom, pastPoints, totalOf, type Badge as Marked, type BadgeData, type RoomMarker } from "./badges";
import { useReads } from "./reads";
import { useUnread } from "./summary";
import { useUpdates } from "../updates/store";

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

/** What's unread in each DM, as its hub counted it, less what's been read
 *  here since. */
export const useUnreadDms = () => {
  const counted = useUnread((s) => s.dms);
  const points = useReads((s) => s.dms);
  return useMemo(() => pastPoints(counted, points), [counted, points]);
};

/** What every item's badge is read from. */
export const useBadgeData = (): BadgeData => {
  const needs = useNeeds();
  const dms = useUnreadDms();
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

/** The version of Desk ready to restart into while it's unread: its
 *  notice hasn't been on screen, nor acted on. */
export const useUnreadUpdate = (): string | null => {
  const version = useUpdates((s) => (s.state.phase === "ready" ? s.state.version : null));
  const seen = useUnread((s) => s.local?.update?.message);
  return version && seen !== version ? version : null;
};

/** Everything unread, each item once. */
export const useTotal = (): Marked => {
  const update = !!useUnreadUpdate();
  const needs: readonly FloorNeed[] = useNeeds();
  const dms = useUnreadDms();
  const local = useUnread((s) => s.local);
  const drafts = useDesk((s) => s.roomDrafts);
  return useMemo(() => totalOf({ needs, dms, local, drafts, update }), [needs, dms, local, drafts, update]);
};
