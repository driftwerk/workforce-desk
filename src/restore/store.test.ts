import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubError, stateRows } from "../hub/client";
import { DeskStateStore, stable, STATE_PREFIXES, type HubState, type LocalState, type StateEntry } from "./store";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

/** Desk's file, as the native side keeps it (adopt refuses a dirty key). */
const fakeFile = (initial: Record<string, StateEntry> = {}) => {
  const entries: Record<string, StateEntry> = structuredClone(initial);
  const local: LocalState & { entries: typeof entries; flushes: number } = {
    entries,
    flushes: 0,
    load: vi.fn(async () => structuredClone(entries)),
    put: vi.fn(async (key, value) => {
      entries[key] = { value, updatedAt: entries[key]?.updatedAt ?? null, dirty: true };
    }),
    remove: vi.fn(async (key) => {
      delete entries[key];
    }),
    synced: vi.fn(async (key, value, updatedAt) => {
      if (entries[key] && stable(entries[key].value) === stable(value)) entries[key] = { value, updatedAt, dirty: false };
    }),
    adopt: vi.fn(async (key, value, updatedAt) => {
      if (entries[key]?.dirty) return false;
      if (value === null) delete entries[key];
      else entries[key] = { value, updatedAt, dirty: false };
      return true;
    }),
    flush: vi.fn(async () => {
      local.flushes += 1;
    }),
  };
  return local;
};

/** A hub with a state store (or, with `missing`, one without the route). */
const fakeHub = (rows: Record<string, unknown> = {}, missing = false) => {
  const kept = new Map(Object.entries(rows).map(([k, v]) => [k, { value: v, updatedAt: "t0" }]));
  let n = 0;
  let down = false;
  const no = () => new HubError(404, "This hub doesn’t have that yet.");
  const hub: HubState & { kept: typeof kept; setDown: (d: boolean) => void } = {
    kept,
    setDown: (d) => (down = d),
    list: vi.fn(async (prefix: string) => {
      if (missing) throw no();
      if (down) throw new TypeError("Load failed");
      return [...kept].filter(([k]) => k.startsWith(prefix)).map(([key, e]) => ({ key, ...e }));
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      if (missing) throw no();
      if (down) throw new TypeError("Load failed");
      const updatedAt = `t${++n}`;
      kept.set(key, { value, updatedAt });
      return { updatedAt };
    }),
    remove: vi.fn(async (key: string) => {
      if (down) throw new TypeError("Load failed");
      kept.delete(key);
    }),
  };
  return hub;
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Desk's state store", () => {
  it("keeps a change in the file at once and sends it to the hub after the debounce", async () => {
    const file = fakeFile();
    const hub = fakeHub();
    const s = new DeskStateStore(file);
    await s.load();
    await s.connect(hub);
    s.set("ui.main", { view: "rooms" });
    s.set("ui.main", { view: "floor" });
    expect(file.put).toHaveBeenLastCalledWith("ui.main", { view: "floor" });
    expect(hub.put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299);
    expect(hub.put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.put).toHaveBeenCalledTimes(1);
    expect(hub.kept.get("ui.main")?.value).toEqual({ view: "floor" });
    expect(file.entries["ui.main"]).toMatchObject({ dirty: false, updatedAt: "t1" });
  });

  it("an unchanged value is no change", async () => {
    const file = fakeFile();
    const s = new DeskStateStore(file);
    s.set("ui.main", { a: 1, b: 2 });
    s.set("ui.main", { b: 2, a: 1 });
    expect(file.put).toHaveBeenCalledTimes(1);
  });

  it("flushing sends what's waiting and writes the file without waiting for the debounce", async () => {
    const file = fakeFile();
    const hub = fakeHub();
    const s = new DeskStateStore(file);
    await s.connect(hub);
    s.set("ui.main", { view: "rooms" });
    await s.flush();
    expect(hub.kept.get("ui.main")?.value).toEqual({ view: "rooms" });
    expect(file.flushes).toBe(1);
  });

  it("with a hub that has no state store, everything stays in the file", async () => {
    {
      const missing = true;
      const file = fakeFile();
      const hub = fakeHub({}, missing);
      const s = new DeskStateStore(file);
      await s.connect(hub);
      expect(s.hubHas).toBe("no");
      s.set("ui.main", { view: "rooms" });
      await vi.advanceTimersByTimeAsync(400);
      expect(hub.put).not.toHaveBeenCalled();
      expect(file.entries["ui.main"]).toMatchObject({ value: { view: "rooms" }, dirty: true });
    }
  });

  it("a hub that answers with its web page has no state store", () => {
    expect(() => stateRows("<!doctype html>")).toThrow(HubError);
    expect(() => stateRows({ error: "not found" })).toThrow(HubError);
    expect(stateRows({ entries: [{ key: "ui.main", value: 1, updatedAt: "t" }] })).toEqual([
      { key: "ui.main", value: 1, updatedAt: "t" },
    ]);
    expect(stateRows([{ key: "k", value: null, updated_at: "u" }])).toEqual([{ key: "k", value: null, updatedAt: "u" }]);
    // The hub has a store but rows Desk can't read (keys without values): said, not empty.
    expect(() => stateRows([{ key: "k", updatedAt: "u" }])).toThrow(/can't read/);
  });

  it("once the hub has a state store, the file's contents move to it, and the hub's own keys come back", async () => {
    const file = fakeFile({
      "ui.main": { value: { view: "rooms", room: "r1" }, dirty: true },
      "window.main.abc": { value: { x: 1 }, dirty: true },
    });
    const s = new DeskStateStore(file);
    await s.load();
    // Before the hub has the route.
    await s.connect(fakeHub({}, true));
    expect(s.hubHas).toBe("no");
    // The hub restarts with it, keeping a frame from another arrangement.
    const hub = fakeHub({ "window.main.def": { x: 9 } });
    const heard = vi.fn();
    s.subscribe("window.", heard);
    await s.connect(hub);
    expect(s.hubHas).toBe("yes");
    expect(hub.kept.get("ui.main")?.value).toEqual({ view: "rooms", room: "r1" });
    expect(hub.kept.get("window.main.abc")?.value).toEqual({ x: 1 });
    expect(file.entries["ui.main"]?.dirty).toBe(false);
    expect(file.entries["window.main.def"]).toMatchObject({ value: { x: 9 }, dirty: false });
    expect(heard).toHaveBeenCalledWith("window.main.def", { x: 9 }, "hub");
    expect(s.list("window.main.").map((e) => e.key)).toEqual(["window.main.abc", "window.main.def"]);
  });

  it("a key changed here and not yet on the hub is never replaced by the hub's older value", async () => {
    const file = fakeFile({ "ui.main": { value: { view: "floor" }, dirty: false, updatedAt: "t0" } });
    const s = new DeskStateStore(file);
    await s.load();
    s.set("ui.main", { view: "rooms" });
    const hub = fakeHub({ "ui.main": { view: "floor" } });
    const watcher = vi.fn();
    s.watch("ui.main", watcher);
    await s.connect(hub);
    expect(s.get("ui.main")).toEqual({ view: "rooms" });
    expect(hub.kept.get("ui.main")?.value).toEqual({ view: "rooms" });
    expect(watcher).not.toHaveBeenCalled();
  });

  it("the hub's announcement of its own copy of a change made here changes nothing", async () => {
    const file = fakeFile();
    const hub = fakeHub();
    const s = new DeskStateStore(file);
    await s.connect(hub);
    const watcher = vi.fn();
    s.watch("ui.main", watcher);
    s.set("ui.main", { view: "rooms" });
    // An older echo arriving while a newer change waits.
    s.set("ui.main", { view: "floor" });
    await s.heard("ui.main", { view: "rooms" });
    expect(s.get("ui.main")).toEqual({ view: "floor" });
    await vi.advanceTimersByTimeAsync(300);
    await s.heard("ui.main", { view: "floor" });
    expect(watcher).not.toHaveBeenCalled();
  });

  it("a change the hub announces is taken and shown when nothing here is waiting", async () => {
    const file = fakeFile();
    const s = new DeskStateStore(file);
    await s.connect(fakeHub());
    const watcher = vi.fn();
    s.watch("ui.main", watcher);
    await s.heard("ui.main", { view: "rooms" });
    expect(watcher).toHaveBeenCalledWith({ view: "rooms" });
    expect(file.entries["ui.main"]).toMatchObject({ value: { view: "rooms" }, dirty: false });
    await s.heard("ui.main", null);
    expect(s.get("ui.main")).toBeUndefined();
  });

  it("while the hub is down changes wait in the file, and go to it when it's back", async () => {
    const file = fakeFile();
    const hub = fakeHub();
    const s = new DeskStateStore(file);
    await s.connect(hub);
    hub.setDown(true);
    s.set("ui.main", { view: "rooms" });
    await vi.advanceTimersByTimeAsync(300);
    expect(hub.kept.has("ui.main")).toBe(false);
    expect(file.entries["ui.main"]?.dirty).toBe(true);
    // The hub restarts: Desk connects again.
    hub.setDown(false);
    await s.connect(hub);
    expect(hub.kept.get("ui.main")?.value).toEqual({ view: "rooms" });
    expect(file.entries["ui.main"]?.dirty).toBe(false);
  });

  it("a removed key leaves the file and the hub, and the hub doesn't bring it back", async () => {
    const file = fakeFile({ "window.main.abc": { value: 1, dirty: false } });
    const hub = fakeHub({ "window.main.abc": 1 });
    const s = new DeskStateStore(file);
    await s.load();
    hub.setDown(true);
    await s.connect(hub);
    s.remove("window.main.abc");
    hub.setDown(false);
    await s.connect(hub);
    expect(hub.kept.has("window.main.abc")).toBe(false);
    expect(s.get("window.main.abc")).toBeUndefined();
  });

  it("frames the native side kept are passed on to the hub", async () => {
    const file = fakeFile();
    const hub = fakeHub();
    const s = new DeskStateStore(file);
    await s.connect(hub);
    const heard = vi.fn();
    s.subscribe("", heard);
    s.native([["window.main.abc", { value: { x: 5 }, dirty: true }]]);
    expect(heard).toHaveBeenCalledWith("window.main.abc", { x: 5 }, "native");
    await vi.advanceTimersByTimeAsync(300);
    expect(hub.kept.get("window.main.abc")?.value).toEqual({ x: 5 });
    expect(file.put).not.toHaveBeenCalled();
  });

  it("a key family registered after the hub connected is read from it at once", async () => {
    const file = fakeFile();
    const hub = fakeHub({ "grid.main": { cells: 4 } });
    const s = new DeskStateStore(file);
    await s.connect(hub);
    expect(s.get("grid.main")).toBeUndefined();
    try {
      await s.register("grid.");
      expect(s.get("grid.main")).toEqual({ cells: 4 });
      s.set("grid.main", { cells: 6 });
      await vi.advanceTimersByTimeAsync(300);
      expect(hub.kept.get("grid.main")?.value).toEqual({ cells: 6 });
    } finally {
      STATE_PREFIXES.delete("grid.");
    }
  });
});
