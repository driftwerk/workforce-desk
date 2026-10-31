import { useCallback, useMemo } from "react";
import type { FloorNeed } from "../floor/merge";
import { useFloor, useNeeds } from "../floor/store";
import { useDesk, type RoomDraft } from "../hub/store";
import { Badge, needsYou } from "../ui/Badge";
import { badgeOfRoom, dmsNotHere, inRoom, notHere, pastPoints, roomNotHere, totalOf, type Badge as Marked, type BadgeData, type RoomMarker } from "./badges";
import { useReads } from "./reads";
import { useUnread } from "./summary";
import { useWatching, watched } from "./watching";
import type { UnreadSummary } from "../hub/types";
import { useUpdates } from "../updates/store";
import { useChat } from "../chat/store";
import { useSessionNames } from "../groups/names";
import { useOverview } from "../overview/store";
import { unreadRows, type UnreadRow } from "./rows";

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

/** Whether a place is on screen in this window now. */
const useHere = (): ((key: string) => boolean) => {
  const w = useWatching();
  return useCallback((key: string) => watched(w, key), [w]);
};

/** What's unread in each DM, as its hub counted it, less what's been read
 *  here since and what's on screen. */
export const useUnreadDms = () => {
  const counted = useUnread((s) => s.dms);
  const points = useReads((s) => s.dms);
  const here = useHere();
  return useMemo(() => dmsNotHere(pastPoints(counted, points), here), [counted, points, here]);
};

/** This computer's summary less what's on screen here and what's been read
 *  past what it counted. */
export const useLocalUnread = (): UnreadSummary | null => {
  const local = useUnread((s) => s.local);
  const points = useReads((s) => s.local);
  const here = useHere();
  return useMemo(() => notHere(local, points, here), [local, points, here]);
};

/** What every item's badge is read from. */
export const useBadgeData = (): BadgeData => {
  const needs = useNeeds();
  const dms = useUnreadDms();
  const sessions = useLocalUnread()?.sessions;
  return useMemo(() => ({ needs, dms, sessions: sessions ?? [] }), [needs, dms, sessions]);
};

const NO_DRAFTS: RoomDraft[] = [];

/** A room's marks: its badge and whether someone is answering in it. */
export const useRoomMarker = (room: string): RoomMarker => {
  const counted = useUnread((s) => s.local?.rooms.find((r) => r.roomId === room));
  const points = useReads((s) => s.local);
  const here = useHere();
  const summary = useMemo(() => counted && roomNotHere(counted, points, here), [counted, points, here]);
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

/** When each ready version was first seen here, for its point. */
const readySince = new Map<string, string>();
const readyAt = (version: string | null): string => {
  if (!version) return "";
  if (!readySince.has(version)) readySince.set(version, new Date().toISOString());
  return readySince.get(version)!;
};

/** The Unread page's rows, as every badge of the total reads them. */
export const useUnreadRows = (): UnreadRow[] => {
  const local = useLocalUnread();
  const dms = useUnreadDms();
  const rooms = useDesk((s) => s.rooms);
  const sessions = useDesk((s) => s.sessions);
  const timelines = useDesk((s) => s.timelines);
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  const sessionNames = useSessionNames();
  const brief = useOverview((s) => s.overview?.brief ?? null);
  const ready = useUnreadUpdate();
  return useMemo(
    () => unreadRows({ local, dms, rooms, roster, hubs, sessions, sessionNames, timelines, brief, ready, readyAt: readyAt(ready) }),
    [local, dms, rooms, roster, hubs, sessions, sessionNames, timelines, brief, ready],
  );
};

/** Everything the Unread page lists, each item once. */
export const useTotal = (): Marked => {
  const needs: readonly FloorNeed[] = useNeeds();
  const rows = useUnreadRows();
  const drafts = useDesk((s) => s.roomDrafts);
  return useMemo(() => totalOf({ needs, rows, drafts }), [needs, rows, drafts]);
};
