import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../hub/types";
import { heard, PAGE, type Feed } from "./store";

const ev = (n: number): ActivityEvent => ({
  id: `e${String(n).padStart(4, "0")}`,
  at: new Date(Date.UTC(2026, 10, 23, 9, 0, n)).toISOString(),
  kind: "started",
  actor: { kind: "session", id: "s1", name: "web" },
  text: "started",
});

/** A feed of events `from` to `to`, newest first. */
const feed = (from: number, to: number, over: Partial<Feed> = {}): Feed => ({
  events: Array.from({ length: to - from + 1 }, (_, i) => ev(to - i)),
  more: false,
  state: "ready",
  earlier: "idle",
  ...over,
});

const ids = (f: Feed) => f.events.map((e) => e.id);

describe("a live event into an Activity list", () => {
  it("lengthens a list shorter than a page", () => {
    const after = heard(feed(1, 3), ev(4));
    expect(ids(after)).toEqual(["e0004", "e0003", "e0002", "e0001"]);
    expect(after.more).toBe(false);
  });

  it("keeps a page a page: the oldest goes, to be read again", () => {
    const after = heard(feed(1, PAGE), ev(PAGE + 1));
    expect(after.events).toHaveLength(PAGE);
    expect(after.events[0]!.id).toBe(ev(PAGE + 1).id);
    expect(after.events.at(-1)!.id).toBe("e0002");
    expect(after.more).toBe(true);
  });

  it("keeps what Show earlier read, at its length", () => {
    const after = heard(feed(1, PAGE * 2, { more: true }), ev(PAGE * 2 + 1));
    expect(after.events).toHaveLength(PAGE * 2);
    expect(after.events.at(-1)!.id).toBe("e0002");
  });

  it("drops nothing while an earlier page is on its way, which follows the oldest shown", () => {
    const after = heard(feed(1, PAGE, { more: true, earlier: "loading" }), ev(PAGE + 1));
    expect(after.events).toHaveLength(PAGE + 1);
    expect(after.events.at(-1)!.id).toBe("e0001");
  });

  it("takes an event it holds already once, the later copy", () => {
    const after = heard(feed(1, PAGE), { ...ev(PAGE), text: "started again" });
    expect(after.events).toHaveLength(PAGE);
    expect(after.events[0]!.text).toBe("started again");
    expect(after.more).toBe(false);
  });
});
