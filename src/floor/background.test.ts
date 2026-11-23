import { describe, expect, it } from "vitest";
import { backgroundLine, bossHandles, lookOf, restartedLine, shownState, statusOf, waitsLine, waitsOnYou } from "./background";
import { clock } from "./time";
import { NOW, at } from "./testing";

describe("work left running in the background", () => {
  it("is said with how many and for how long", () => {
    expect(backgroundLine({ count: 2, since: at(6) }, NOW)).toBe("Waiting on 2 background tasks · 6m");
    expect(backgroundLine({ count: 1, since: at(65) }, NOW)).toBe("Waiting on 1 background task · 1h 05m");
  });

  it("says what a held-up session waits on and for how long", () => {
    expect(waitsLine({ words: "waiting for a build slot", since: at(3) }, NOW)).toBe("waiting for a build slot, 3m");
  });

  it("keeps a session that's done but still running work working", () => {
    expect(shownState({ state: "done", background: { count: 1, since: at(1) } })).toBe("working");
    expect(shownState({ state: "done", background: null })).toBe("done");
    expect(shownState({ state: "done" })).toBe("done");
    expect(shownState({ state: "blocked", background: { count: 1, since: at(1) } })).toBe("blocked");
  });

  it("says a restarted session is re-checking its work, never waiting on what stopped", () => {
    const restarted = { at: at(3), stopped: 6 };
    const labels = { starting: "Starting", working: "Working", blocked: "Blocked", asking: "Asking", done: "Done", idle: "Idle", interrupted: "Interrupted", stopped: "Stopped", closed: "Closed" } as const;
    const line = `Restarted ${clock(at(3))}, re-checking its work`;
    expect(restartedLine({ state: "working", restarted })).toBe(line);
    expect(statusOf({ state: "working", restarted, background: null }, labels, NOW)).toBe(line);
    expect(restartedLine({ state: "done", restarted })).toBeNull();
    expect(statusOf({ state: "done", restarted: null, background: null }, labels, NOW)).toBe("Done");
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
