import { create } from "zustand";
import { shownState } from "../floor/background";
import { notificationFor, notify } from "../shell/notify";
import type { Prompt, Working } from "../chat/conversation";
import type { Attachment, ToolCall } from "../chat/types";
import { DeskHub, ROOM_PAGE, type HubConnection } from "./client";
import type { DeskEvent, Room, RoomMessage, Session } from "./types";

/** The main window's views: the Floor, Rooms, and Grids. */
export type View = "rooms" | "floor" | "grids";

interface DeskState {
  hub: DeskHub | null;
  connected: boolean;
  sessions: Record<string, Session>;
  restore: Session[];
  rooms: Record<string, Room>;
  /** Loaded timelines (main and threads), by room id. */
  timelines: Record<string, RoomMessage[]>;
  activeRoom: string | null;
  /** Agent messages in rooms you aren't looking at. */
  unread: Record<string, number>;
  /** Answers on their way in each room, oldest first, by room id. */
  roomDrafts: Record<string, RoomDraft[]>;
  putDraft: (roomId: string, draft: RoomDraft) => void;
  dropDraft: (roomId: string, id: string) => void;
  /** A message kept in a room just now, shown at once. */
  keep: (message: RoomMessage) => void;
  openId: string | null;
  view: View;
  error: string | null;
  /** A detached grid's window, which leaves telling the system of sessions'
   *  changes, and handing Desk's groups to the hub, to the main window. */
  detached: boolean;
  /** With `notify: false`, this is a detached grid's window. */
  connect: (conn: HubConnection, opts?: { notify?: boolean }) => () => void;
  open: (id: string | null) => void;
  setView: (view: View) => void;
  openRoom: (id: string | null) => Promise<void>;
  /** Reads a room's latest messages again, keeping those already read
   *  (after a restore, or the hub coming back). */
  reloadRoom: (id: string) => Promise<void>;
  /** The hub has said which rooms and sessions it has. */
  loaded: boolean;
  openThread: (roomId: string, threadId: string) => Promise<void>;
  fail: (e: unknown) => void;
  clearError: () => void;
}

/** A member's answer to something said in a room, while it's on its way:
 *  what it has said so far and is doing, until it is posted. */
export interface RoomDraft {
  /** The ask it answers. */
  id: string;
  /** Who is answering (`hub/agent`). */
  member: string;
  threadId: string | null;
  text: string;
  working: Working | null;
  tools: ToolCall[];
  attachments: Attachment[];
  prompts: Prompt[];
  /** `queued`: waiting for the member's answer in another thread. */
  state: "queued" | "live" | "stalled" | "interrupted" | "failed";
  error?: string;
  /** What its answer is posted under, once the hub has said its id. */
  source?: string;
}

/** Drafts once `posted` is in the room: the one it answered is done. */
const answered = (drafts: Record<string, RoomDraft[]>, posted: RoomMessage): Record<string, RoomDraft[]> => {
  const here = drafts[posted.roomId];
  if (!posted.source || !here?.some((d) => d.source === posted.source)) return drafts;
  return { ...drafts, [posted.roomId]: here.filter((d) => d.source !== posted.source) };
};

/** Others listening to the events socket (the overview, Activity). */
export const deskListeners = new Set<(e: DeskEvent) => void>();

const later = (a: string | null | undefined, b: string): string => (a && a.localeCompare(b) > 0 ? a : b);

/** `parent` with one more reply, `reply`, counted; a parent from a hub that
 *  counts none is left to the replies loaded. */
const counted = (parent: RoomMessage, reply: RoomMessage): RoomMessage =>
  parent.replyCount === undefined
    ? parent
    : { ...parent, replyCount: parent.replyCount + 1, lastReplyAt: later(parent.lastReplyAt, reply.createdAt) };

/** Messages by id, oldest first. */
export const merge = (a: RoomMessage[], b: RoomMessage[]): RoomMessage[] => {
  const byId = new Map(a.map((m) => [m.id, m]));
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
};

/** `timeline` with `message`, kept as it happened: a reply new to the
 *  timeline counts on its parent; one already in it, by id, does not. */
export const arrived = (timeline: RoomMessage[], message: RoomMessage): RoomMessage[] => {
  const fresh = !!message.threadId && !timeline.some((m) => m.id === message.id);
  const merged = merge(timeline, [message]);
  return fresh ? merged.map((m) => (m.id === message.threadId ? counted(m, message) : m)) : merged;
};

/** `timeline` with thread `threadId` read: its parent counts the replies
 *  loaded once they are all of them (`whole`, the read came back short of a
 *  page), and never fewer than the hub counted while some may be unread. */
export const threadRead = (timeline: RoomMessage[], threadId: string, whole: boolean): RoomMessage[] => {
  const replies = timeline.filter((m) => m.threadId === threadId);
  const last = replies.at(-1)?.createdAt ?? null;
  return timeline.map((m) => {
    if (m.id !== threadId) return m;
    if (whole) return { ...m, replyCount: replies.length, lastReplyAt: last };
    return m.replyCount === undefined
      ? m
      : { ...m, replyCount: Math.max(m.replyCount, replies.length), lastReplyAt: last ? later(m.lastReplyAt, last) : m.lastReplyAt };
  });
};

const applyRooms = (rooms: Record<string, Room>, e: DeskEvent): Record<string, Room> => {
  switch (e.type) {
    case "snapshot":
      return Object.fromEntries(e.rooms.map((r) => [r.id, r]));
    case "room":
      return { ...rooms, [e.room.id]: e.room };
    case "roomRemoved": {
      const { [e.id]: _gone, ...rest } = rooms;
      return rest;
    }
    default:
      return rooms;
  }
};

const apply = (sessions: Record<string, Session>, e: DeskEvent): Record<string, Session> => {
  switch (e.type) {
    case "snapshot":
      return Object.fromEntries(e.sessions.map((s) => [s.id, s]));
    case "session":
      return { ...sessions, [e.session.id]: e.session };
    case "removed": {
      const { [e.id]: _gone, ...rest } = sessions;
      return rest;
    }
    default:
      return sessions;
  }
};

export const useDesk = create<DeskState>((set, get) => ({
  hub: null,
  connected: false,
  sessions: {},
  restore: [],
  rooms: {},
  timelines: {},
  activeRoom: null,
  unread: {},
  roomDrafts: {},
  putDraft: (roomId, draft) =>
    set((s) => {
      const here = s.roomDrafts[roomId] ?? [];
      const at = here.findIndex((d) => d.id === draft.id);
      const next = at < 0 ? [...here, draft] : here.map((d, i) => (i === at ? draft : d));
      return { roomDrafts: { ...s.roomDrafts, [roomId]: next } };
    }),
  dropDraft: (roomId, id) =>
    set((s) =>
      s.roomDrafts[roomId]?.some((d) => d.id === id)
        ? { roomDrafts: { ...s.roomDrafts, [roomId]: s.roomDrafts[roomId]!.filter((d) => d.id !== id) } }
        : s,
    ),
  keep: (message) =>
    set((s) => ({
      timelines: s.timelines[message.roomId]
        ? { ...s.timelines, [message.roomId]: arrived(s.timelines[message.roomId]!, message) }
        : s.timelines,
      roomDrafts: answered(s.roomDrafts, message),
    })),
  openId: null,
  view: "floor",
  loaded: false,
  error: null,
  detached: false,
  connect: (conn, opts) => {
    const hub = new DeskHub(conn);
    set({ hub, detached: opts?.notify === false });
    return hub.events(
      (e) => {
        if (e.type === "session" && !get().detached) {
          const was = get().sessions[e.session.id];
          const n = notificationFor(was && shownState(was), e.session);
          if (n) void notify(n);
        }
        set((s) => ({
          rooms: applyRooms(s.rooms, e),
          timelines:
            e.type === "roomMessage" && s.timelines[e.message.roomId]
              ? { ...s.timelines, [e.message.roomId]: arrived(s.timelines[e.message.roomId]!, e.message) }
              : s.timelines,
          roomDrafts: e.type === "roomMessage" ? answered(s.roomDrafts, e.message) : s.roomDrafts,
          // A room gone while Desk was closed is no longer open; one the hub
          // still has stays open through its restart.
          activeRoom:
            (e.type === "roomRemoved" && s.activeRoom === e.id) ||
            (e.type === "snapshot" && s.activeRoom && !e.rooms.some((r) => r.id === s.activeRoom))
              ? null
              : s.activeRoom,
          loaded: s.loaded || e.type === "snapshot",
          unread:
            e.type === "roomMessage" && e.message.author !== "you" && !(s.view === "rooms" && s.activeRoom === e.message.roomId)
              ? { ...s.unread, [e.message.roomId]: (s.unread[e.message.roomId] ?? 0) + 1 }
              : s.unread,
          sessions: apply(s.sessions, e),
          restore: e.type === "snapshot" ? e.restore : s.restore.filter((r) => e.type !== "session" || r.id !== e.session.id),
          openId: e.type === "removed" && s.openId === e.id ? null : s.openId,
        }));
        for (const f of deskListeners) f(e);
      },
      (connected) => {
        set({ connected });
        // Back after a hub restart (or first connected after a restore):
        // the open room shows what was said meanwhile.
        const room = get().activeRoom;
        if (connected && room) void get().reloadRoom(room);
      },
    );
  },
  // The session opens as a column beside whatever the main area shows,
  // the Floor included.
  open: (openId) => set({ openId }),
  setView: (view) => set({ view }),
  openRoom: async (id) => {
    set((s) => ({ activeRoom: id, view: "rooms", unread: id ? { ...s.unread, [id]: 0 } : s.unread }));
    const hub = get().hub;
    if (!id || !hub || get().timelines[id]) return;
    try {
      const main = await hub.roomMessages(id);
      set((s) => ({ timelines: { ...s.timelines, [id]: merge(s.timelines[id] ?? [], main) } }));
    } catch (e) {
      get().fail(e);
    }
  },
  reloadRoom: async (id) => {
    const hub = get().hub;
    if (!hub) return;
    try {
      const main = await hub.roomMessages(id);
      set((s) => ({ timelines: { ...s.timelines, [id]: merge(s.timelines[id] ?? [], main) } }));
    } catch {
      /* Shown as it was; read again when the hub is back. */
    }
  },
  openThread: async (roomId, threadId) => {
    const hub = get().hub;
    if (!hub) return;
    try {
      const replies = await hub.roomMessages(roomId, threadId);
      const whole = replies.length < ROOM_PAGE;
      set((s) => ({ timelines: { ...s.timelines, [roomId]: threadRead(merge(s.timelines[roomId] ?? [], replies), threadId, whole) } }));
    } catch (e) {
      get().fail(e);
    }
  },
  fail: (e) => set({ error: e instanceof Error ? e.message : String(e) }),
  clearError: () => set({ error: null }),
}));

const RANK: Record<Session["state"], number> = {
  blocked: 0,
  working: 1,
  starting: 1,
  done: 2,
  interrupted: 3,
  idle: 4,
  stopped: 5,
  closed: 6,
};

export const sortedSessions = (sessions: Record<string, Session>): Session[] =>
  Object.values(sessions).sort(
    (a, b) => RANK[shownState(a)] - RANK[shownState(b)] || b.updatedAt.localeCompare(a.updatedAt),
  );
