import { describe, expect, it } from "vitest";
import { countsByItem, itemKeyOf, nameOf } from "./needs";
import { agent, session } from "./testing";

describe("the needs index", () => {
  it("keys this computer's sessions by id, another hub's by its hub, and agents by hub", () => {
    expect(itemKeyOf({ hubId: "local", local: true, who: session("s-1") })).toBe("session:s-1");
    expect(itemKeyOf({ hubId: "b", local: false, who: session("s-1") })).toBe("session:b/s-1");
    expect(itemKeyOf({ hubId: "b", local: false, who: agent("scout") })).toBe("agent:b/scout");
  });

  it("calls this computer's sessions by the names given them, and no other hub's", () => {
    const names = { "s-1": "date picker" };
    expect(nameOf({ local: true, who: session("s-1", "web") }, names)).toBe("date picker");
    expect(nameOf({ local: false, who: session("s-1", "web") }, names)).toBe("web");
    expect(nameOf({ local: true, who: agent("s-1", "Scout") }, names)).toBe("Scout");
  });

  it("counts needs per item, the same agent on two hubs apart", () => {
    const counts = countsByItem([
      { hubId: "local", local: true, who: session("s-1") },
      { hubId: "local", local: true, who: session("s-1") },
      { hubId: "local", local: true, who: agent("scout") },
      { hubId: "b", local: false, who: agent("scout") },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ "session:s-1": 2, "agent:local/scout": 1, "agent:b/scout": 1 });
  });
});
