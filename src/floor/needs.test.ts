import { describe, expect, it } from "vitest";
import { countsByItem, itemKeyOf } from "./needs";
import { agent, session } from "./testing";

describe("the needs index", () => {
  it("keys sessions by id and agents by hub", () => {
    expect(itemKeyOf("local", session("s-1"))).toBe("session:s-1");
    expect(itemKeyOf("b", agent("scout"))).toBe("agent:b/scout");
  });

  it("counts needs per item, the same agent on two hubs apart", () => {
    const counts = countsByItem([
      { hubId: "local", who: session("s-1") },
      { hubId: "local", who: session("s-1") },
      { hubId: "local", who: agent("scout") },
      { hubId: "b", who: agent("scout") },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ "session:s-1": 2, "agent:local/scout": 1, "agent:b/scout": 1 });
  });
});
