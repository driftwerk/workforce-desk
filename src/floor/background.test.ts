import { describe, expect, it } from "vitest";
import { backgroundLine, shownState } from "./background";
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
