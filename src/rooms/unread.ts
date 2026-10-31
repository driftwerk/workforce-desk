import { create } from "zustand";
import type { ReadPoint, RoomMessage, Unread } from "../hub/types";
import { after, instant } from "./time";
import type { PlaceKey, Window } from "./window";

// What a room's timeline says of what's unread in it: where the New line
// goes, and the pill that takes you to what you haven't seen.

/** Whether a message counts as unread at all: yours and copies never do. */
export const countsAsUnread = (m: RoomMessage): boolean => m.author !== "you" && !m.copyOf;

/** The first message after the point the place was read through when it
 *  was shown; null when there's none. */
export const dividerBefore = (shown: readonly RoomMessage[], readAtOpen: ReadPoint | null | undefined): string | null =>
  readAtOpen ? (shown.find((m) => countsAsUnread(m) && after(m, readAtOpen.at))?.id ?? null) : null;

export type Pill =
  /** "3 new · Allan answered" */
  | { dir: "down"; count: number; lead: string | null }
  /** "12 new since 09:14" */
  | { dir: "up"; count: number; since: string };

/** The pill a place shows: up when what's unread starts before what's
 *  loaded, down when some of it is below the last message showing (or past
 *  a window that isn't live); none when it's all in sight. */
export const pill = (p: {
  shown: readonly RoomMessage[];
  read: ReadPoint | null | undefined;
  lastVisible: string | null;
  window: Window | undefined;
  unread: Unread | undefined;
  name: (author: string) => string;
}): Pill | null => {
  const { read, window: w, unread } = p;
  if (read && unread?.count && w?.older.kind === "at" && instant(read.at) < instant(w.older.at) && unread.first && !p.shown.some((m) => m.id === unread.first))
    return { dir: "up", count: unread.count, since: read.at };
  const from = p.lastVisible ? p.shown.findIndex((m) => m.id === p.lastVisible) + 1 : 0;
  const below = p.shown.slice(from).filter((m) => countsAsUnread(m) && (!read || after(m, read.at)));
  const live = !w || w.newer.kind === "end";
  const count = live ? below.length : Math.max(below.length, unread?.count ?? 0);
  if (!count) return null;
  const lead = [...below].reverse().find((m) => m.forYou);
  return { dir: "down", count, lead: lead ? p.name(lead.author) : null };
};

/** Each place's point as it was when the place was shown, for its New
 *  line; cleared when you mark it all read. */
export const useDividers = create<Record<PlaceKey, ReadPoint | null>>(() => ({}));
export const setDivider = (place: PlaceKey, point: ReadPoint | null): void => useDividers.setState({ [place]: point });

/** What Jump to new messages does in each place shown, by place key. */
export const jumpers = new Map<PlaceKey, () => void>();
