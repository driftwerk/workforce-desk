import { describe, expect, it } from "vitest";
import type { RoomMessage } from "../hub/types";
import { afterPage, aroundSplit, inWindow, newestRun, shown, type Window } from "./window";

const m = (id: string, sec: number): RoomMessage => ({
  id,
  roomId: "r1",
  threadId: null,
  author: "you",
  content: id,
  hop: 0,
  createdAt: `2026-10-27T09:00:${String(sec).padStart(2, "0")}Z`,
});
const at = (x: RoomMessage) => ({ kind: "at" as const, id: x.id, at: x.createdAt });
const all = Array.from({ length: 10 }, (_, i) => m(`m${i}`, i));
const START = { kind: "start" } as const;
const END = { kind: "end" } as const;

describe("a place's window after a page", () => {
  it("is live from the newest page, reaching the start when the page is short", () => {
    expect(afterPage(undefined, "newest", all.slice(7), 3)).toEqual({ older: at(all[7]!), newer: END });
    expect(afterPage(undefined, "newest", all.slice(8), 3)).toEqual({ older: START, newer: END });
  });

  it("goes further back with an older page, and reaches the start with a short one", () => {
    const w: Window = { older: at(all[7]!), newer: END };
    expect(afterPage(w, "older", all.slice(4, 7), 3)).toEqual({ older: at(all[4]!), newer: END });
    expect(afterPage(w, "older", all.slice(5, 7), 3)).toEqual({ older: START, newer: END });
  });

  it("comes forward with a newer page, and is live again with a short one", () => {
    const w: Window = { older: at(all[2]!), newer: at(all[4]!) };
    expect(afterPage(w, "newer", all.slice(5, 8), 3)).toEqual({ older: at(all[2]!), newer: at(all[7]!) });
    expect(afterPage(w, "newer", all.slice(5, 7), 3)).toEqual({ older: at(all[2]!), newer: END });
  });

  it("holds a jumped-to message with what came before and after, short at either end", () => {
    expect(aroundSplit(4)).toEqual({ before: 2, after: 2 });
    expect(aroundSplit(5)).toEqual({ before: 3, after: 2 });
    expect(afterPage(undefined, { around: "m5" }, all.slice(4, 8), 4)).toEqual({ older: at(all[4]!), newer: at(all[7]!) });
    expect(afterPage(undefined, { around: "m0" }, all.slice(0, 3), 4)).toEqual({ older: START, newer: at(all[2]!) });
    expect(afterPage(undefined, { around: "m9" }, all.slice(8), 4)).toEqual({ older: at(all[8]!), newer: END });
  });

  it("replaces a window it doesn't touch, and joins one it does", () => {
    const live: Window = { older: at(all[7]!), newer: END };
    expect(afterPage(live, { around: "m2" }, all.slice(1, 5), 4)).toEqual({ older: at(all[1]!), newer: at(all[4]!) });
    expect(afterPage(live, { around: "m6" }, all.slice(5, 9), 4)).toEqual({ older: at(all[5]!), newer: END });
    const jumped: Window = { older: at(all[1]!), newer: at(all[3]!) };
    expect(afterPage(jumped, "newest", all.slice(7), 3)).toEqual({ older: at(all[7]!), newer: END });
  });
});

describe("what a window shows", () => {
  it("shows its place's messages inside it, oldest first, and all of them without one", () => {
    const w: Window = { older: at(all[2]!), newer: at(all[4]!) };
    expect(shown([...all].reverse(), w).map((x) => x.id)).toEqual(["m2", "m3", "m4"]);
    expect(shown(all, undefined)).toHaveLength(10);
    expect(inWindow(all[5]!, w)).toBe(false);
  });

  it("tells an ask nothing of a window that isn't live", () => {
    expect(newestRun(all, { older: at(all[2]!), newer: at(all[4]!) })).toEqual([]);
    expect(newestRun(all, { older: at(all[8]!), newer: END }).map((x) => x.id)).toEqual(["m8", "m9"]);
    expect(newestRun(all, undefined)).toHaveLength(10);
  });
});
