import { describe, expect, it } from "vitest";
import type { Agent } from "../chat/types";
import { parseAsk } from "./QuickAsk";

const roster: Agent[] = [
  { hubId: "dw", id: "allan", name: "allan", model: null, provider: null, isDefault: false },
  { hubId: "acme", id: "atlas", name: "atlas", model: null, provider: null, isDefault: false },
  { hubId: "dw", id: "lara", name: "lara", model: null, provider: null, isDefault: false },
];

describe("parseAsk", () => {
  it("resolves a name and keeps the message", () => {
    const p = parseAsk("@allan what is left?", roster);
    expect(p.agent?.id).toBe("allan");
    expect(p.text).toBe("what is left?");
  });

  it("resolves a unique prefix but not an ambiguous one", () => {
    expect(parseAsk("@atl hi", roster).agent?.id).toBe("atlas");
    expect(parseAsk("@a hi", roster).agent).toBeNull();
    expect(parseAsk("@a hi", roster).matches).toHaveLength(2);
  });
});
