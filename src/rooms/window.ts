import type { RoomMessage } from "../hub/types";
import { byTime } from "./time";

// What of a place (a room's main timeline, or one thread) is loaded without a
// gap. Messages stay merged in the room's timeline however they were read;
// the view shows only its place's window, so a jump back thousands of
// messages shows one unbroken span, and sending returns to the newest first.

/** One place of a room: its main timeline, or a thread. */
export type PlaceKey = string;
export const placeKey = (room: string, thread: string | null): PlaceKey => (thread ? `${room}/${thread}` : room);

/** One end of a window: the place's start or end, or a message. */
export type Edge = { kind: "start" } | { kind: "end" } | { kind: "at"; id: string; at: string };

/** The span of a place loaded without a gap: from `older` (or the start)
 *  to `newer` (or the end, live). */
export interface Window {
  older: Edge;
  newer: Edge;
}

/** Which page of a place to read next. */
export type PageDir = "newest" | "older" | "newer" | { around: string };

const START: Edge = { kind: "start" };
const END: Edge = { kind: "end" };
const at = (m: RoomMessage): Edge => ({ kind: "at", id: m.id, at: m.createdAt });

const rank = (e: Edge): number => (e.kind === "start" ? -1 : e.kind === "end" ? 1 : 0);

/** Below, at or above zero as edge `a` comes before, at or after edge `b`. */
const compare = (a: Edge, b: Edge): number =>
  a.kind === "at" && b.kind === "at" ? byTime({ id: a.id, createdAt: a.at }, { id: b.id, createdAt: b.at }) : rank(a) - rank(b);

export const isLive = (w: Window | undefined): boolean => !w || w.newer.kind === "end";

/** Whether `m` is inside `w`; everything is, without one. */
export const inWindow = (m: RoomMessage, w: Window | undefined): boolean =>
  !w || (compare(at(m), w.older) >= 0 && compare(at(m), w.newer) <= 0);

/** Two windows as one, when they touch or overlap; null when there's a gap. */
const union = (a: Window, b: Window): Window | null =>
  compare(a.older, b.newer) <= 0 && compare(b.older, a.newer) <= 0
    ? { older: compare(a.older, b.older) <= 0 ? a.older : b.older, newer: compare(a.newer, b.newer) >= 0 ? a.newer : b.newer }
    : null;

/** How an `around` page of `limit` divides: this many at or before its
 *  target (the target included), the rest after it, as the hub reads it. */
export const aroundSplit = (limit: number): { before: number; after: number } => {
  const before = Math.max(1, Math.ceil(limit / 2));
  return { before, after: limit - before };
};

/** The window a fetched page (oldest first) leaves `w` with. A short page
 *  reached the start or the end; an `around` page is split at its target to
 *  tell which side was short. A page that touches `w` extends it, and one
 *  that doesn't replaces it. */
export const afterPage = (w: Window | undefined, dir: PageDir, page: readonly RoomMessage[], limit: number): Window => {
  const sorted = [...page].sort(byTime);
  const first = sorted[0];
  const last = sorted.at(-1);
  const short = sorted.length < limit;
  let read: Window;
  if (dir === "older") {
    if (!w) return { older: short || !first ? START : at(first), newer: END };
    return { older: short || !first ? START : at(first), newer: w.newer };
  } else if (dir === "newer") {
    if (!w) return { older: !first ? START : at(first), newer: END };
    return { older: w.older, newer: short || !last ? END : at(last) };
  } else if (dir === "newest") {
    read = { older: short || !first ? START : at(first), newer: END };
  } else {
    const target = sorted.find((m) => m.id === dir.around);
    const split = aroundSplit(limit);
    const before = target ? sorted.filter((m) => byTime(m, target) <= 0).length : 0;
    const after = sorted.length - before;
    read = {
      older: before < split.before || !first ? START : at(first),
      newer: after < split.after || !last ? END : at(last),
    };
  }
  return (w && union(w, read)) ?? read;
};

/** A place's messages inside its window, oldest first. */
export const shown = (messages: readonly RoomMessage[], w: Window | undefined): RoomMessage[] =>
  messages.filter((m) => inWindow(m, w)).sort(byTime);

/** What an ask may be told of a place: everything in its window when that
 *  is live (all of it without one), else nothing, so a context never
 *  carries a gap. */
export const newestRun = (messages: readonly RoomMessage[], w: Window | undefined): RoomMessage[] =>
  isLive(w) ? shown(messages, w) : [];

/** The messages of place `thread` (null: the main timeline) in a room's timeline. */
export const ofPlace = (timeline: readonly RoomMessage[], thread: string | null): RoomMessage[] =>
  timeline.filter((m) => (m.threadId ?? null) === thread);
