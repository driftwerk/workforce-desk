import { describe, expect, it } from "vitest";
import type { BossPlanDetail } from "../hub/types";
import { sound } from "./planStore";

const detail = (over: Record<string, unknown>) => ({ id: "p", tickets: [], waves: [], revisions: [], ...over }) as unknown as BossPlanDetail;

describe("a plan detail's goal", () => {
  it("is kept as sent when it is words", () => {
    const d = detail({ goal: "Ship the checkout" });
    expect(sound(d)).toBe(d);
  });

  it("is never an object to render (DW-749)", () => {
    const d = detail({ goal: { parts: [{ met: false }] }, result: { words: "CI is fast", parts: [] } });
    expect(sound(d).goal).toBe("CI is fast");
    expect(sound(detail({ goal: { parts: [] } })).goal).toBe("");
  });
});
