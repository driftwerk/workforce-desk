import { describe, expect, it } from "vitest";
import type { RoomMessage } from "../hub/types";
import { dividerBefore, pill } from "./unread";

const at = (sec: number) => new Date(Date.UTC(2026, 9, 27, 9, 0, sec)).toISOString();
const m = (id: string, sec: number, over: Partial<RoomMessage> = {}): RoomMessage => ({
  id,
  roomId: "r1",
  threadId: null,
  author: "local/allan",
  content: id,
  hop: 0,
  createdAt: at(sec),
  ...over,
});
const names = (key: string) => (key === "local/allan" ? "Allan" : key === "dw/sarah" ? "Sarah" : key);
const shown = [m("a", 1, { author: "you" }), m("b", 2), m("c", 3, { author: "you" }), m("d", 4, { author: "dw/sarah", forYou: true }), m("e", 5, { copyOf: "x" })];

describe("the New line", () => {
  it("goes before the first message after the point, never yours or a copy", () => {
    expect(dividerBefore(shown, { at: at(1), message: "a" })).toBe("b");
    expect(dividerBefore(shown, { at: at(2), message: "b" })).toBe("d");
    expect(dividerBefore(shown, { at: at(4), message: "d" })).toBeNull();
    expect(dividerBefore(shown, null)).toBeNull();
  });
});

describe("the jump pill", () => {
  const base = { shown, name: names, window: { older: { kind: "start" as const }, newer: { kind: "end" as const } }, unread: undefined };

  it("points down to what's unread below the last message showing, led by who answered you", () => {
    expect(pill({ ...base, read: { at: at(1), message: "a" }, lastVisible: "a" })).toEqual({ dir: "down", count: 2, lead: "Sarah" });
    expect(pill({ ...base, read: { at: at(1), message: "a" }, lastVisible: "b" })).toEqual({ dir: "down", count: 1, lead: "Sarah" });
    expect(pill({ ...base, read: { at: at(1), message: "a" }, lastVisible: "e" })).toBeNull();
  });

  it("points up when what's unread starts before what's loaded", () => {
    const window = { older: { kind: "at" as const, id: "a", at: at(1) }, newer: { kind: "end" as const } };
    const unread = { count: 12, forYou: 2, first: "z", lastAt: at(5) };
    expect(pill({ ...base, window, unread, read: { at: at(0), message: null }, lastVisible: "e" })).toEqual({ dir: "up", count: 12, since: at(0) });
  });

  it("counts what's past a window that isn't live", () => {
    const window = { older: { kind: "start" as const }, newer: { kind: "at" as const, id: "e", at: at(5) } };
    const unread = { count: 7, forYou: 0, first: "b", lastAt: at(90) };
    expect(pill({ ...base, window, unread, read: { at: at(1), message: "a" }, lastVisible: "e" })).toEqual({ dir: "down", count: 7, lead: null });
  });
});
