import { create } from "zustand";
import { shownState } from "../floor/background";
import type { Prompt, Working } from "../chat/conversation";
import type { Attachment, ToolCall } from "../chat/types";
import { DeskHub, HubError, ROOM_PAGE } from "./client";
import { explain, type ExplainOptions, type Problem } from "../ui/problem";
import type { DeskTransport } from "./transport";
import { keyOf, LOCAL, machineOf, splitKey, type MachineId } from "./machines";
import { byTime, later } from "../rooms/time";
import { afterPage, inWindow, isLive, ofPlace, placeKey, shown, type PageDir, type PlaceKey, type Window } from "../rooms/window";
import type { DeskEvent, Room, RoomMessage, Session } from "./types";

/** The main window's views: the Floor, Rooms, and Grids. */
export type View = "rooms" | "floor" | "grids" | "board";

/** One engine the page talks to: this computer's (`local`) or a machine's. Each
 *  runs its own sessions, boss, board, lines, budgets and breaker. */
export interface EngineConn {
  hub: DeskHub;
  /** Its events socket is open. */
  connected: boolean;
  /** It has said which sessions it has. */
  loaded: boolean;
  error: string | null;
}

interface DeskState {
  /** This computer's engine (`engines.local`), as everything that is about
   *  this computer alone reaches it. */
  hub: DeskHub | null;
  /** This computer's engine's events socket is open. */
  connected: boolean;
  /** Every engine, by machine id; `local` is this computer. */
  engines: Record<MachineId, EngineConn>;
  /** Every engine's sessions, by key (see `keyOf`): this computer's by their own
   *  id, a machine's as `<machine>/<id>`, stamped with its `machine`. */
  sessions: Record<string, Session>;
  restore: Session[];
  rooms: Record<string, Room>;
  /** Loaded timelines (main and threads), by room id. */
  timelines: Record<string, RoomMessage[]>;
  /** What of each place (a room's main timeline, a thread) is loaded
   *  without a gap, by place key; a place without one shows all it has. */
  windows: Record<PlaceKey, Window>;
  /** A place whose page is being read, or failed to be, by place key. */
  paging: Record<PlaceKey, "loading" | "failed">;
  /** Reads a page of a place and widens (or moves) its window to it; one
   *  read of a place at a time, the next waiting for it. */
  page: (roomId: string, thread: string | null, dir: PageDir) => Promise<void>;
  /** Loads what's around message `id` of a room, its thread's too for a
   *  reply; which thread it's in, or null when the message is gone. */
  reveal: (roomId: string, id: string) => Promise<{ thread: string | null } | null>;
  /** Back to a place's newest messages, unless it shows them already. */
  toNewest: (roomId: string, thread: string | null) => Promise<void>;
  activeRoom: string | null;
  /** Answers on their way in each room, oldest first, by room id. */
  roomDrafts: Record<string, RoomDraft[]>;
  putDraft: (roomId: string, draft: RoomDraft) => void;
  dropDraft: (roomId: string, id: string) => void;
  /** A message kept in a room just now, shown at once. */
  /** Keeps a message posted to a room; one the hub had already (`created`
   *  false) is counted on its thread already. */
  keep: (message: RoomMessage, created?: boolean) => void;
  openId: string | null;
  view: View;
  /** Rooms shows the Unread page. */
  inbox: boolean;
  /** Rooms with the Unread page, or back from it. */
  setInbox: (on: boolean) => void;
  error: Problem | null;
  /** A detached grid's window, which leaves telling the system of sessions'
   *  changes, and handing Desk's groups to the hub, to the main window. */
  detached: boolean;
  /** With `notify: false`, this is a detached grid's window. */
  /** Talks to the local hub through `transport` (`brokered` in the app). */
  connect: (transport: DeskTransport, opts?: { notify?: boolean }) => () => void;
  /** Talks to machine `machine`'s engine through `transport`
   *  (`machineTransport` in the app); stopped, its engine and sessions go. */
  connectMachine: (machine: MachineId, transport: DeskTransport) => () => void;
  open: (id: string | null) => void;
  setView: (view: View) => void;
  openRoom: (id: string | null) => Promise<void>;
  /** Reads a room's latest messages again, keeping those already read
   *  (after a restore, or the hub coming back). */
  reloadRoom: (id: string) => Promise<void>;
  /** The hub has said which rooms and sessions it has. */
  loaded: boolean;
  openThread: (roomId: string, threadId: string) => Promise<void>;
  /** Shows what went wrong as a `Problem`: plain words, a fix, the raw text under Details. */
  fail: (e: unknown, opts?: ExplainOptions) => void;
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
  /** The room message it answers. */
  asked: string;
  /** When it was asked, or sent once it was (ms). */
  since: number;
  /** When its conversation dropped, while it's stalled. */
  stalledSince?: number;
  /** How many later asks its live turn took in. */
  took?: number;
  text: string;
  working: Working | null;
  tools: ToolCall[];
  attachments: Attachment[];
  prompts: Prompt[];
  /** `queued`: waiting for the member's answer in another thread;
   *  `connecting`: waiting for the member's conversation to open; `busy`:
   *  waiting for the member to finish something elsewhere; `stopped`: you
   *  stopped it. */
  state: "queued" | "connecting" | "busy" | "live" | "stalled" | "stopped" | "interrupted" | "failed";
  error?: string;
  /** Why it failed, as a code a fix is chosen by: `workspace_gone`, its
   *  member's workspace isn't connected to Desk any more. */
  reason?: "workspace_gone";
  /** What its answer is posted under, once the hub has said its id. */
  source?: string;
}

/** Whether `posted` is the answer `d` was waiting for: its source, or for
 *  one you stopped, an answer by its member to what it was asked (a turn
 *  that ended just before the stop reached the hub). */
const answers = (posted: RoomMessage, d: RoomDraft): boolean =>
  (!!posted.source && d.source === posted.source) ||
  (d.state === "stopped" && !!posted.inReplyTo && posted.inReplyTo === d.asked && posted.author === d.member);

/** Drafts once `posted` is in the room: the one it answered is done. */
export const answered = (drafts: Record<string, RoomDraft[]>, posted: RoomMessage): Record<string, RoomDraft[]> => {
  const here = drafts[posted.roomId];
  if (!here?.some((d) => answers(posted, d))) return drafts;
  return { ...drafts, [posted.roomId]: here.filter((d) => !answers(posted, d)) };
};

/** Others listening to this computer's events socket (the overview, Activity, and
 *  everything else that is about this computer alone). */
export const deskListeners = new Set<(e: DeskEvent) => void>();

/** An event as it came from its engine: a machine's says which (this computer's
 *  say none, as before machines). Its sessions are stamped too. */
export type EngineEvent = DeskEvent & { machine?: MachineId };

/** Others listening to every engine's events socket, this computer's included:
 *  what is about sessions wherever they run (panes, unread, notifications). */
export const engineListeners = new Set<(e: EngineEvent) => void>();

/** Tells everyone listening what engine `e`'s machine said: this
 *  computer's events go to both sets, a machine's only to
 *  `engineListeners`. */
export const announce = (e: EngineEvent): void => {
  if (machineOf(e) === LOCAL) for (const f of deskListeners) f(e);
  for (const f of engineListeners) f(e);
};

/** `s` stamped with its machine; this computer's as they are. */
const stamped = (s: Session, machine: MachineId): Session => (machine === LOCAL ? s : { ...s, machine });

/** `e` as heard from `machine`: stamped, its sessions too. */
export const stampEvent = (e: DeskEvent, machine: MachineId): EngineEvent => {
  if (machine === LOCAL) return e;
  switch (e.type) {
    case "snapshot":
      return { ...e, machine, sessions: e.sessions.map((x) => stamped(x, machine)), restore: e.restore.map((x) => stamped(x, machine)) };
    case "session":
      return { ...e, machine, session: stamped(e.session, machine) };
    default:
      return { ...e, machine };
  }
};

/** Whether key `k` is one of `machine`'s sessions. */
const onMachine = (k: string, machine: MachineId): boolean => splitKey(k).machine === machine;

/** Every session but `machine`'s. */
const others = (sessions: Record<string, Session>, machine: MachineId): Record<string, Session> =>
  Object.values(sessions).some((s) => machineOf(s) === machine)
    ? Object.fromEntries(Object.entries(sessions).filter(([k]) => !onMachine(k, machine)))
    : sessions;

/** Every session but this computer's, by key. */
const remoteOf = (sessions: Record<string, Session>): Record<string, Session> =>
  Object.fromEntries(Object.entries(sessions).filter(([k]) => !onMachine(k, LOCAL)));

/** The engine `machine` (this computer when none), while the page talks to
 *  it: this computer's is `hub`, as it has always been. */
const engineIn = (s: DeskState, machine?: MachineId | null): DeskHub | null =>
  !machine || machine === LOCAL ? s.hub : (s.engines[machine]?.hub ?? null);

/** The engine `machine` (this computer when none), while the page talks to it. */
export const hubOf = (machine?: MachineId | null): DeskHub | null => engineIn(useDesk.getState(), machine);

/** The engine session `s` runs on. */
export const hubFor = (s: { machine?: MachineId | null }): DeskHub | null => hubOf(machineOf(s));

/** The engine `machine`, as a hook. */
export const useHubOf = (machine?: MachineId | null): DeskHub | null => useDesk((s) => engineIn(s, machine));

const localOnly = new WeakMap<Record<string, Session>, Record<string, Session>>();

/** This computer's sessions alone, for what shows this computer's (the sidebar's
 *  groups, the board, budgets): the same object while there are no others,
 *  and the same object for the same sessions, so it is safe in a selector. */
export const localSessions = (sessions: Record<string, Session>): Record<string, Session> => {
  const was = localOnly.get(sessions);
  if (was) return was;
  const keys = Object.keys(sessions);
  const mine = keys.every((k) => onMachine(k, LOCAL)) ? sessions : Object.fromEntries(keys.filter((k) => onMachine(k, LOCAL)).map((k) => [k, sessions[k]!]));
  localOnly.set(sessions, mine);
  return mine;
};

/** The latest three to reply, `author` now first. */
const repliers = (was: readonly string[] | undefined, author: string): string[] => [author, ...(was ?? []).filter((a) => a !== author)].slice(0, 3);

/** `parent` with one more reply, `reply`, counted; a parent from a hub that
 *  counts none is left to the replies loaded. */
const counted = (parent: RoomMessage, reply: RoomMessage): RoomMessage =>
  parent.replyCount === undefined
    ? parent
    : {
        ...parent,
        replyCount: parent.replyCount + 1,
        lastReplyAt: later(parent.lastReplyAt, reply.createdAt),
        replyAuthors: repliers(parent.replyAuthors, reply.author),
      };

/** Messages by id, oldest first. */
export const merge = (a: RoomMessage[], b: RoomMessage[]): RoomMessage[] => {
  const byId = new Map(a.map((m) => [m.id, m]));
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort(byTime);
};

/** `timeline` with `message`, kept as it happened: a reply new to the
 *  timeline counts on its parent, unless the hub had it already (`created`
 *  false); one already in it, by id, does not. */
export const arrived = (timeline: RoomMessage[], message: RoomMessage, created = true): RoomMessage[] => {
  const fresh = created && !!message.threadId && !timeline.some((m) => m.id === message.id);
  const merged = merge(timeline, [message]);
  const answered = message.author === "you" ? message.inReplyTo : null;
  return merged.map((m) => {
    let next = fresh && m.id === message.threadId ? counted(m, message) : m;
    // A copy posted to the room shows on its original; your answer to a
    // form locks it, as the hub reads them back.
    if (m.id === message.copyOf && !m.postedToRoom) next = { ...next, postedToRoom: true };
    if (m.id === answered && !m.answered) next = { ...next, answered: true };
    return next;
  });
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

/** `sessions` once `machine`'s engine said `e` (already stamped): its
 *  snapshot replaces its own sessions, and only those. */
export const apply = (sessions: Record<string, Session>, e: DeskEvent, machine: MachineId = LOCAL): Record<string, Session> => {
  switch (e.type) {
    case "snapshot": {
      const mine = Object.fromEntries(e.sessions.map((s) => [keyOf(machine, s.id), s]));
      // This computer's first, as before machines.
      return machine === LOCAL ? { ...mine, ...remoteOf(sessions) } : { ...others(sessions, machine), ...mine };
    }
    case "session":
      return { ...sessions, [keyOf(machine, e.session.id)]: e.session };
    case "removed": {
      const { [keyOf(machine, e.id)]: _gone, ...rest } = sessions;
      return rest;
    }
    default:
      return sessions;
  }
};

/** What a page in direction `dir` asks the hub for; null when the window
 *  already reaches that end. */
const queryFor = (w: Window | undefined, dir: PageDir): { before?: string; after?: string; around?: string } | null => {
  if (dir === "newest") return {};
  if (dir === "older") return !w ? {} : w.older.kind === "at" ? { before: w.older.id } : null;
  if (dir === "newer") return w?.newer.kind === "at" ? { after: w.newer.id } : null;
  return { around: dir.around };
};

/** Reads of each place under way, so the next waits for the last. */
const reading = new Map<PlaceKey, Promise<void>>();

/** `engines` with `machine`'s changed by `patch`, while it's there. */
const patched = (engines: Record<MachineId, EngineConn>, machine: MachineId, patch: Partial<EngineConn>): Record<MachineId, EngineConn> =>
  engines[machine] ? { ...engines, [machine]: { ...engines[machine]!, ...patch } } : engines;

export const useDesk = create<DeskState>((set, get) => ({
  hub: null,
  connected: false,
  engines: {},
  sessions: {},
  restore: [],
  rooms: {},
  timelines: {},
  windows: {},
  paging: {},
  activeRoom: null,
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
  keep: (message, created = true) =>
    set((s) => ({
      timelines: s.timelines[message.roomId]
        ? { ...s.timelines, [message.roomId]: arrived(s.timelines[message.roomId]!, message, created) }
        : s.timelines,
      roomDrafts: answered(s.roomDrafts, message),
    })),
  openId: null,
  view: "floor",
  inbox: false,
  setInbox: (inbox) => set(inbox ? { inbox, view: "rooms" } : { inbox }),
  loaded: false,
  error: null,
  detached: false,
  connect: (transport, opts) => {
    const hub = new DeskHub(transport);
    set((s) => ({
      hub,
      detached: opts?.notify === false,
      engines: { ...s.engines, [LOCAL]: { hub, connected: false, loaded: false, error: null } },
    }));
    return hub.events(
      (e) => {
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
          sessions: apply(s.sessions, e),
          restore: e.type === "snapshot" ? e.restore : s.restore.filter((r) => e.type !== "session" || r.id !== e.session.id),
          openId: e.type === "removed" && s.openId === e.id ? null : s.openId,
          engines: e.type === "snapshot" ? patched(s.engines, LOCAL, { loaded: true }) : s.engines,
        }));
        announce(e);
      },
      (connected) => {
        set((s) => ({ connected, engines: s.engines[LOCAL]?.hub === hub ? patched(s.engines, LOCAL, { connected }) : s.engines }));
        // Back after a hub restart (or first connected after a restore):
        // the open room shows what was said meanwhile.
        const room = get().activeRoom;
        if (connected && room) void get().reloadRoom(room);
      },
    );
  },
  connectMachine: (machine, transport) => {
    if (machine === LOCAL) throw new Error("This computer's engine is connected with `connect`.");
    const hub = new DeskHub(transport);
    set((s) => ({ engines: { ...s.engines, [machine]: { hub, connected: false, loaded: false, error: null } } }));
    const mine = () => get().engines[machine]?.hub === hub;
    const stop = hub.events(
      (raw) => {
        if (!mine()) return;
        const e = stampEvent(raw, machine);
        // Only its sessions: its rooms, restore list, layout and state are
        // its own (this computer's are this computer's).
        set((s) => ({
          sessions: apply(s.sessions, e, machine),
          openId:
            (e.type === "removed" && s.openId === keyOf(machine, e.id)) ||
            (e.type === "snapshot" && s.openId && onMachine(s.openId, machine) && !e.sessions.some((x) => keyOf(machine, x.id) === s.openId))
              ? null
              : s.openId,
          engines: e.type === "snapshot" ? patched(s.engines, machine, { loaded: true }) : s.engines,
        }));
        announce(e);
      },
      (connected) => {
        if (mine()) set((s) => ({ engines: patched(s.engines, machine, { connected }) }));
      },
    );
    return () => {
      stop();
      if (!mine()) return;
      set((s) => {
        const { [machine]: _gone, ...engines } = s.engines;
        return { engines, sessions: others(s.sessions, machine), openId: s.openId && onMachine(s.openId, machine) ? null : s.openId };
      });
    };
  },
  // The session opens as a column beside whatever the main area shows,
  // the Floor included.
  open: (openId) => set({ openId }),
  setView: (view) => set({ view }),
  openRoom: async (id) => {
    set({ activeRoom: id, view: "rooms", inbox: false });
    if (!id || !get().hub || get().windows[id]) return;
    await get()
      .page(id, null, "newest")
      .catch((e: unknown) => get().fail(e));
  },
  reloadRoom: async (id) => {
    if (!isLive(get().windows[id])) return;
    await get()
      .page(id, null, "newest")
      .catch(() => {
        /* Shown as it was; read again when the hub is back. */
      });
  },
  openThread: async (roomId, threadId) => {
    // A thread jumped back into stays where it was.
    if (!isLive(get().windows[placeKey(roomId, threadId)])) return;
    await get()
      .page(roomId, threadId, "newest")
      .catch((e: unknown) => get().fail(e));
  },
  page: (roomId, thread, dir) => {
    const key = placeKey(roomId, thread);
    const read = async () => {
      const hub = get().hub;
      const q = queryFor(get().windows[key], dir);
      if (!hub || !q) return;
      set((s) => ({ paging: { ...s.paging, [key]: "loading" } }));
      try {
        const page = await hub.roomMessages(roomId, { ...(thread ? { thread } : {}), ...q, limit: ROOM_PAGE });
        set((s) => {
          const was = s.windows[key];
          const window = afterPage(was, dir, page, ROOM_PAGE, dir === "newest" ? shown(ofPlace(s.timelines[roomId] ?? [], thread), was) : []);
          const merged = merge(s.timelines[roomId] ?? [], page);
          // A thread's loaded replies are its count only once they're all of it.
          const whole = window.older.kind === "start" && window.newer.kind === "end";
          const { [key]: _done, ...paging } = s.paging;
          return {
            timelines: { ...s.timelines, [roomId]: thread ? threadRead(merged, thread, whole) : merged },
            windows: { ...s.windows, [key]: window },
            paging,
          };
        });
      } catch (e) {
        set((s) => ({ paging: { ...s.paging, [key]: "failed" } }));
        throw e;
      }
    };
    const run = (reading.get(key) ?? Promise.resolve()).catch(() => undefined).then(read);
    reading.set(key, run);
    void run.finally(() => reading.get(key) === run && reading.delete(key)).catch(() => undefined);
    return run;
  },
  reveal: async (roomId, id) => {
    const hub = get().hub;
    if (!hub) return null;
    const find = () => get().timelines[roomId]?.find((m) => m.id === id);
    let m = find();
    if (!m) {
      try {
        m = await hub.roomMessage(roomId, id);
      } catch (e) {
        if (e instanceof HubError && (e.status === 404 || e.status === 400)) return null;
        throw e;
      }
    }
    const thread = m.threadId ?? null;
    const showing = (x: RoomMessage | undefined, place: string | null) => !!x && inWindow(x, get().windows[placeKey(roomId, place)]);
    if (thread) {
      const parent = get().timelines[roomId]?.find((x) => x.id === thread);
      if (!showing(parent, null)) await get().page(roomId, null, { around: thread });
    }
    if (!showing(find(), thread)) await get().page(roomId, thread, { around: id });
    return { thread };
  },
  toNewest: async (roomId, thread) => {
    if (!isLive(get().windows[placeKey(roomId, thread)])) await get().page(roomId, thread, "newest");
  },
  fail: (e, opts) => set({ error: explain(e, { localDown: !get().connected, ...opts }) }),
  clearError: () => set({ error: null }),
}));

const RANK: Record<Session["state"], number> = {
  blocked: 0,
  asking: 0,
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
