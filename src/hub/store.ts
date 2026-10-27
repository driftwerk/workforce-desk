import { create } from "zustand";
import { notificationFor, notify } from "../shell/notify";
import { DeskHub, type HubConnection } from "./client";
import type { DeskEvent, Room, RoomMessage, Session } from "./types";

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
  openId: string | null;
  view: "rooms" | "floor";
  error: string | null;
  connect: (conn: HubConnection) => () => void;
  open: (id: string | null) => void;
  setView: (view: "rooms" | "floor") => void;
  openRoom: (id: string | null) => Promise<void>;
  openThread: (roomId: string, threadId: string) => Promise<void>;
  fail: (e: unknown) => void;
  clearError: () => void;
}

/** Messages by id, oldest first. */
export const merge = (a: RoomMessage[], b: RoomMessage[]): RoomMessage[] => {
  const byId = new Map(a.map((m) => [m.id, m]));
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
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
  openId: null,
  view: "floor",
  error: null,
  connect: (conn) => {
    const hub = new DeskHub(conn);
    set({ hub });
    return hub.events(
      (e) => {
        if (e.type === "session") {
          const n = notificationFor(get().sessions[e.session.id]?.state, e.session);
          if (n) void notify(n);
        }
        set((s) => ({
          rooms: applyRooms(s.rooms, e),
          timelines:
            e.type === "roomMessage" && s.timelines[e.message.roomId]
              ? { ...s.timelines, [e.message.roomId]: merge(s.timelines[e.message.roomId]!, [e.message]) }
              : s.timelines,
          activeRoom: e.type === "roomRemoved" && s.activeRoom === e.id ? null : s.activeRoom,
          unread:
            e.type === "roomMessage" && e.message.author !== "you" && !(s.view === "rooms" && s.activeRoom === e.message.roomId)
              ? { ...s.unread, [e.message.roomId]: (s.unread[e.message.roomId] ?? 0) + 1 }
              : s.unread,
          sessions: apply(s.sessions, e),
          restore: e.type === "snapshot" ? e.restore : s.restore.filter((r) => e.type !== "session" || r.id !== e.session.id),
          openId: e.type === "removed" && s.openId === e.id ? null : s.openId,
        }));
      },
      (connected) => set({ connected }),
    );
  },
  open: (openId) => set({ openId, view: openId && get().view === "floor" ? "rooms" : get().view }),
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
  openThread: async (roomId, threadId) => {
    const hub = get().hub;
    if (!hub) return;
    try {
      const replies = await hub.roomMessages(roomId, threadId);
      set((s) => ({ timelines: { ...s.timelines, [roomId]: merge(s.timelines[roomId] ?? [], replies) } }));
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
    (a, b) => RANK[a.state] - RANK[b.state] || b.updatedAt.localeCompare(a.updatedAt),
  );
