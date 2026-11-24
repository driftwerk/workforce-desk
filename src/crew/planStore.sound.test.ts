import { describe, expect, it } from "vitest";
import type { BossPlanDetail } from "../hub/types";
import { sound } from "./planStore";

const detail = (over: Record<string, unknown>) =>
  ({
    id: "p",
    revision: 2,
    tickets: [],
    waves: [],
    revisions: [1, 2].map((revision) => ({ revision, snapshot: { goal: `Goal ${revision}`, tickets: [] } })),
    ...over,
  }) as unknown as BossPlanDetail;

describe("a plan detail's goal", () => {
  it("is kept as sent when it is words", () => {
    const d = detail({ goal: "Ship the checkout" });
    expect(sound(d)).toBe(d);
  });

  it("is its revision's words when an older hub sends its progress", () => {
    expect(sound(detail({ goal: { parts: [] } }), "Known").goal).toBe("Goal 2");
  });

  it("is the words already known when the revision isn't there", () => {
    expect(sound(detail({ goal: { parts: [] }, revisions: [] }), "Known").goal).toBe("Known");
    expect(sound(detail({ goal: { parts: [] }, revisions: [] })).goal).toBe("");
  });
});
