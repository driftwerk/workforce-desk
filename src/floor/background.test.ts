import { describe, expect, it } from "vitest";
import { backgroundLine, bossHandles, lookOf, shownState, statusOf, waitsOnYou } from "./background";
import { NOW, at } from "./testing";

describe("work left running in the background", () => {
  it("is said with how many and for how long", () => {
    expect(backgroundLine({ count: 2, since: at(6) }, NOW)).toBe("Waiting on 2 background tasks · 6m");
    expect(backgroundLine({ count: 1, since: at(65) }, NOW)).toBe("Waiting on 1 background task · 1h 05m");
  });

  it("keeps a session that's done but still running work working", () => {
    expect(shownState({ state: "done", background: { count: 1, since: at(1) } })).toBe("working");
    expect(shownState({ state: "done", background: null })).toBe("done");
    expect(shownState({ state: "done" })).toBe("done");
    expect(shownState({ state: "blocked", background: { count: 1, since: at(1) } })).toBe("blocked");
  });
});

// 19 Nov: "if Desk is driving it and dealing with it then it doesn't need me".
describe("a session its boss has", () => {
  const labels = { starting: "starting", working: "working", blocked: "needs you", asking: "asked", done: "done", idle: "idle", interrupted: "interrupted", stopped: "stopped", closed: "closed" } as const;

  it("waits on nobody but its boss: calm, said as the boss having it", () => {
    for (const state of ["blocked", "asking"] as const) {
      const s = { state, bossHas: "Desk" };
      expect(waitsOnYou(s)).toBe(false);
      expect(bossHandles(s)).toBe(true);
      expect(lookOf(s)).toBe("handled");
      expect(statusOf(s, labels)).toBe("Desk has it");
    }
  });

  it("is the person's as ever with no boss on it", () => {
    expect(waitsOnYou({ state: "blocked" })).toBe(true);
    expect(waitsOnYou({ state: "asking", bossHas: undefined })).toBe(true);
    expect(lookOf({ state: "asking" })).toBe("blocked");
    expect(statusOf({ state: "blocked" }, labels)).toBe("needs you");
  });

  it("only changes what it waits on: working is working", () => {
    expect(bossHandles({ state: "working", bossHas: "Desk" })).toBe(false);
    expect(lookOf({ state: "working", bossHas: "Desk" })).toBe("working");
  });
});
