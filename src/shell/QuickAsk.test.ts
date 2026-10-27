import { describe, expect, it } from "vitest";
import type { Agent } from "../chat/types";
import { parseAsk } from "./QuickAsk";

const roster: Agent[] = [
  { hubId: "dw", id: "allan", name: "allan", model: null },
  { hubId: "acme", id: "atlas", name: "atlas", model: null },
  { hubId: "dw", id: "lara", name: "lara", model: null },
];

describe("parseAsk", () => {
  it("resolves a name and keeps the message", () => {
    const p = parseAsk("@allan what is left?", roster);
    expect(p.agent?.id).toBe("allan");
    expect(p.text).toBe("what is left?");
  });

  it("resolves a unique prefix but not an ambiguous one", () => {
    expect(parseAsk("@lat hi", roster).agent?.id).toBe("atlas");
    expect(parseAsk("@la hi", roster).agent).toBeNull();
    expect(parseAsk("@la hi", roster).matches).toHaveLength(2);
  });
});
