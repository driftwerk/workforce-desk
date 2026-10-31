import { describe, expect, it } from "vitest";
import type { FloorEntry } from "./happening";
import { SUMMARY_EVERY_MS, needsLine, paragraphOf, refreshed } from "./summary";
import { agent, at, session } from "./testing";

const entry = (who: FloorEntry["who"], state: FloorEntry["state"]): FloorEntry => ({
  hubId: "local",
  local: true,
  stale: false,
  key: `local/${who.kind}:${who.id}`,
  who,
  place: { kind: "dm" },
  state,
  background: null,
  purpose: null,
  now: "Working on it now.",
  at: at(1),
});

describe("Desk's own paragraph", () => {
  it("says when nothing is going on", () => {
    expect(paragraphOf([])).toBe("Nothing is running right now.");
  });

  it("names who is under way and who finished lately, three at most, by the person's names", () => {
    expect(
      paragraphOf(
        [
          entry(agent("scout", "Scout"), "working"),
          entry(session("s-1", "hub-name"), "waiting"),
          entry(agent("lens", "Lens"), "working"),
          entry(agent("atlas", "Atlas"), "working"),
          entry(agent("herald", "Herald"), "done"),
        ],
        { "s-1": "auth-fix" },
      ),
    ).toBe("Scout, auth-fix, Lens and 1 more are under way. Herald finished lately.");
    expect(paragraphOf([entry(agent("scout", "Scout"), "working")])).toBe("Scout is under way.");
  });

  it("says what needs the person as it is now", () => {
    expect(needsLine(0)).toBe("Nothing needs you.");
    expect(needsLine(1)).toBe("One thing needs you.");
    expect(needsLine(3)).toBe("Three things need you.");
  });

  it("changes at most every ten minutes, and only when it would say something else", () => {
    const first = refreshed(null, "Scout is under way.", 0);
    expect(first).toEqual({ text: "Scout is under way.", at: 0 });
    expect(refreshed(first, "Scout is under way.", SUMMARY_EVERY_MS * 3)).toBe(first);
    expect(refreshed(first, "Nothing is running right now.", SUMMARY_EVERY_MS - 1)).toBe(first);
    expect(refreshed(first, "Nothing is running right now.", SUMMARY_EVERY_MS)).toEqual({
      text: "Nothing is running right now.",
      at: SUMMARY_EVERY_MS,
    });
  });
});
