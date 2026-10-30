import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { Room } from "../hub/types";
import { restore } from "../restore/boot";
import { DeskStateStore, stable, type HubState, type LocalState, type StateEntry } from "../restore/store";
import { arranged, followRooms, forgetRoom, moveRoom, nudgeRoom, ROOM_ORDER_KEY, roomOrder, ROOMS_PREFIX, useRoomOrder } from "./order";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  onNativeState: vi.fn(() => Promise.resolve(() => {})),
  subscribe: vi.fn(() => () => {}),
  stateLoad: vi.fn(),
  statePut: vi.fn(),
  stateRemove: vi.fn(),
  stateSynced: vi.fn(),
  stateAdopt: vi.fn(),
  stateFlush: vi.fn(),
}));

/** Desk's file, as its native side keeps it (adopt refuses a dirty key). */
const fakeFile = (initial: Record<string, StateEntry> = {}) => {
  const entries: Record<string, StateEntry> = structuredClone(initial);
  const local: LocalState & { entries: typeof entries } = {
    entries,
    load: async () => structuredClone(entries),
    put: async (key, value) => void (entries[key] = { value: structuredClone(value), updatedAt: null, dirty: true }),
    remove: async (key) => void delete entries[key],
    synced: async (key, value, updatedAt) => {
      if (entries[key] && stable(entries[key].value) === stable(value)) entries[key] = { value, updatedAt, dirty: false };
    },
    adopt: async (key, value, updatedAt) => {
      if (entries[key]?.dirty) return false;
      if (value === null) delete entries[key];
      else entries[key] = { value, updatedAt, dirty: false };
      return true;
    },
    flush: async () => {},
  };
  return local;
};

const fakeHub = () => {
  const kept = new Map<string, unknown>();
  const hub: HubState & { kept: typeof kept } = {
    kept,
    list: async (prefix) => [...kept].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value, updatedAt: "t" })),
    put: async (key, value) => {
      kept.set(key, structuredClone(value));
      return { updatedAt: "t" };
    },
    remove: async (key) => void kept.delete(key),
  };
  return hub;
};

const started = async (file: LocalState, hub: HubState | null) => {
  const store = new DeskStateStore(file, 0);
  await store.load();
  await store.register(ROOMS_PREFIX);
  await store.connect(hub);
  return store;
};

const room = (id: string, createdAt: string, name = id) => ({ id, slug: id, name, members: [], defaultMember: null, createdAt, updatedAt: createdAt }) as Room;
const ROOMS = { a: room("a", "2026-01-01"), b: room("b", "2026-02-01"), c: room("c", "2026-03-01") };
const ids = () => arranged(useDesk.getState().rooms, useRoomOrder.getState().order).map((r) => r.id);

beforeEach(() => {
  useRoomOrder.setState({ order: [] });
  useDesk.setState({ rooms: ROOMS, loaded: true });
});

describe("the rooms' order", () => {
  it("lists the rooms it names first, then new ones, oldest first, and leaves out rooms that are gone", () => {
    expect(arranged(ROOMS, [])).toEqual([ROOMS.a, ROOMS.b, ROOMS.c]);
    expect(arranged(ROOMS, ["c", "gone", "a"]).map((r) => r.id)).toEqual(["c", "a", "b"]);
    const d = room("d", "2025-01-01");
    // A new room goes at the end, however old.
    expect(arranged({ ...ROOMS, d }, ["c", "b", "a"]).map((r) => r.id)).toEqual(["c", "b", "a", "d"]);
  });

  it("moves by dragging and by Alt+↑/↓, keeping every room it shows", () => {
    moveRoom("c", "a");
    expect(useRoomOrder.getState().order).toEqual(["c", "a", "b"]);
    moveRoom("c", null);
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(nudgeRoom("a", -1)).toBe(false);
    expect(nudgeRoom("a", 1)).toBe(true);
    expect(ids()).toEqual(["b", "a", "c"]);
  });

  it("is kept on the hub and comes back after a restart, on this computer or another", async () => {
    const hub = fakeHub();
    const file = fakeFile();
    const first = await started(file, hub);
    const stop = restore(first, roomOrder);
    moveRoom("c", "a");
    nudgeRoom("b", -1);
    expect(ids()).toEqual(["c", "b", "a"]);
    await first.flush();
    stop();
    expect(hub.kept.get(ROOM_ORDER_KEY)).toEqual({ order: ["c", "b", "a"] });

    // Another computer, which kept nothing.
    useRoomOrder.setState({ order: [] });
    const other = restore(await started(fakeFile(), hub), roomOrder);
    expect(ids()).toEqual(["c", "b", "a"]);
    other();

    // This one, from its file alone.
    useRoomOrder.setState({ order: [] });
    restore(await started(fakeFile(file.entries), null), roomOrder)();
    expect(ids()).toEqual(["c", "b", "a"]);
  });

  it("drops a room deleted elsewhere, but not while the hub hasn't said which rooms it has", () => {
    useRoomOrder.setState({ order: ["c", "a", "b"] });
    useDesk.setState({ rooms: {}, loaded: false });
    const stop = followRooms();
    // Starting up: no rooms yet isn't every room gone.
    useDesk.setState({ rooms: ROOMS, loaded: true });
    expect(useRoomOrder.getState().order).toEqual(["c", "a", "b"]);
    const { a: _gone, ...rest } = ROOMS;
    useDesk.setState({ rooms: rest });
    expect(useRoomOrder.getState().order).toEqual(["c", "b"]);
    forgetRoom("c");
    expect(useRoomOrder.getState().order).toEqual(["b"]);
    stop();
  });
});

describe("rooms before you first arrange them", () => {
  it("stay by name, so nothing reshuffles on upgrade", () => {
    const rooms = { b: room("b", "2026-01-01T00:00:00Z", "Zeta"), a: room("a", "2026-02-01T00:00:00Z", "Alpha") };
    expect(arranged(rooms, []).map((r) => r.name)).toEqual(["Alpha", "Zeta"]);
    expect(arranged({ ...rooms, c: room("c", "2026-03-01T00:00:00Z", "Beta") }, ["b"]).map((r) => r.name)).toEqual(["Zeta", "Alpha", "Beta"]);
  });
});
