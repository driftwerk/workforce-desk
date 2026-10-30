import { beforeEach, describe, expect, it, vi } from "vitest";
import { HubError } from "./client";
import { arrived, useDesk } from "./store";
import type { RoomMessage } from "./types";

const ROOM = "r1";
const msg = (id: string, sec: number, over: Partial<RoomMessage> = {}): RoomMessage => ({
  id,
  roomId: ROOM,
  threadId: null,
  author: "you",
  content: id,
  hop: 0,
  createdAt: new Date(Date.UTC(2026, 9, 27, 9, 0, sec)).toISOString(),
  ...over,
});

/** A hub holding `all`, paging as the hub does: by (time, id), `limit` at most. */
const hubOf = (all: RoomMessage[]) => {
  const calls: Record<string, unknown>[] = [];
  const sorted = [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return {
    calls,
    hub: {
      roomMessages: vi.fn(async (_room: string, q: { thread?: string; before?: string; after?: string; around?: string; limit?: number }) => {
        calls.push(q);
        const limit = q.limit ?? 100;
        const place = sorted.filter((m) => (m.threadId ?? undefined) === q.thread);
        const at = (id: string) => place.findIndex((m) => m.id === id);
        if (q.before) return place.slice(Math.max(0, at(q.before) - limit), at(q.before));
        if (q.after) return place.slice(at(q.after) + 1, at(q.after) + 1 + limit);
        if (q.around) {
          const i = at(q.around);
          if (i < 0) throw new HubError(400, "that message is in a thread");
          const before = Math.ceil(limit / 2);
          return place.slice(Math.max(0, i - before + 1), i + 1 + (limit - before));
        }
        return place.slice(-limit);
      }),
      roomMessage: vi.fn(async (_room: string, id: string) => {
        const m = sorted.find((x) => x.id === id);
        if (!m) throw new HubError(404, "no such message");
        return m;
      }),
    },
  };
};

const ids = (thread: string | null = null) => {
  const s = useDesk.getState();
  const key = thread ? `${ROOM}/${thread}` : ROOM;
  const w = s.windows[key];
  return (s.timelines[ROOM] ?? [])
    .filter((m) => (m.threadId ?? null) === thread)
    .filter((m) => {
      if (!w) return true;
      const t = (e: typeof w.older) => (e.kind === "at" ? e.at : null);
      const lo = t(w.older);
      const hi = t(w.newer);
      return (!lo || m.createdAt >= lo) && (!hi || m.createdAt <= hi);
    })
    .map((m) => m.id);
};

const main = Array.from({ length: 250 }, (_, i) => msg(`m${String(i).padStart(3, "0")}`, i));

beforeEach(() => {
  useDesk.setState({ rooms: {}, timelines: {}, windows: {}, paging: {}, roomDrafts: {}, activeRoom: null });
});

describe("a room's pages", () => {
  it("opens on the newest page and reads earlier ones until the start", async () => {
    const { hub } = hubOf(main);
    useDesk.setState({ hub: hub as never });
    await useDesk.getState().openRoom(ROOM);
    expect(ids()).toHaveLength(100);
    expect(useDesk.getState().windows[ROOM]).toMatchObject({ older: { kind: "at", id: "m150" }, newer: { kind: "end" } });
    await useDesk.getState().page(ROOM, null, "older");
    await useDesk.getState().page(ROOM, null, "older");
    expect(ids()).toHaveLength(250);
    expect(useDesk.getState().windows[ROOM]!.older).toEqual({ kind: "start" });
  });

  it("reads one page of a place at a time, the next after the last", async () => {
    const { hub, calls } = hubOf(main);
    useDesk.setState({ hub: hub as never });
    await useDesk.getState().openRoom(ROOM);
    await Promise.all([useDesk.getState().page(ROOM, null, "older"), useDesk.getState().page(ROOM, null, "older")]);
    expect(calls.slice(1).map((q) => q.before)).toEqual(["m150", "m050"]);
  });

  it("jumps around a message far back, and doesn't show what arrives live until it's back at the newest", async () => {
    const { hub } = hubOf(main);
    useDesk.setState({ hub: hub as never });
    await useDesk.getState().openRoom(ROOM);
    await useDesk.getState().reveal(ROOM, "m010");
    expect(ids()).toContain("m010");
    expect(ids()).not.toContain("m249");
    useDesk.getState().keep(msg("live", 400, { author: "local/scout" }));
    expect(ids()).not.toContain("live");
    await useDesk.getState().toNewest(ROOM, null);
    expect(ids()).toContain("live");
    expect(ids()).not.toContain("m010");
  });

  it("opens the thread of a reply around it, and its parent in the main timeline", async () => {
    const replies = Array.from({ length: 150 }, (_, i) => msg(`r${String(i).padStart(3, "0")}`, 300 + i, { threadId: "m005" }));
    const { hub } = hubOf([...main, ...replies]);
    useDesk.setState({ hub: hub as never });
    await useDesk.getState().openRoom(ROOM);
    expect(await useDesk.getState().reveal(ROOM, "r020")).toEqual({ thread: "m005" });
    expect(ids()).toContain("m005");
    expect(ids("m005")).toContain("r020");
    expect(await useDesk.getState().reveal(ROOM, "gone")).toBeNull();
  });

  it("counts a thread from its replies only once all of them are read", async () => {
    const parent = msg("m000", 0, { replyCount: 150 });
    const replies = Array.from({ length: 150 }, (_, i) => msg(`r${String(i).padStart(3, "0")}`, 300 + i, { threadId: "m000" }));
    const { hub } = hubOf([parent, ...replies]);
    useDesk.setState({ hub: hub as never });
    await useDesk.getState().openRoom(ROOM);
    await useDesk.getState().openThread(ROOM, "m000");
    expect(useDesk.getState().timelines[ROOM]!.find((m) => m.id === "m000")?.replyCount).toBe(150);
    useDesk.setState((s) => ({ timelines: { [ROOM]: s.timelines[ROOM]!.map((m) => (m.id === "m000" ? { ...m, replyCount: 151 } : m)) } }));
    await useDesk.getState().page(ROOM, "m000", "older");
    expect(useDesk.getState().timelines[ROOM]!.find((m) => m.id === "m000")?.replyCount).toBe(150);
  });
});

describe("a reply arriving", () => {
  it("puts its author first among the thread's three latest", () => {
    const parent = msg("p", 0, { replyCount: 3, replyAuthors: ["dw/allan", "local/scout", "you"] });
    const after = arrived([parent], msg("r", 1, { threadId: "p", author: "dw/sarah" }));
    expect(after[0]!.replyAuthors).toEqual(["dw/sarah", "dw/allan", "local/scout"]);
    const again = arrived(after, msg("r2", 2, { threadId: "p", author: "dw/allan" }));
    expect(again[0]!.replyAuthors).toEqual(["dw/allan", "dw/sarah", "local/scout"]);
  });
});
