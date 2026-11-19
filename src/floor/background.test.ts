import { describe, expect, it } from "vitest";
import { backgroundLine, restartedLine, shownState, statusOf } from "./background";
import { clock } from "./time";
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
