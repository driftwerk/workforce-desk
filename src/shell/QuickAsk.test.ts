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

  it("finds an agent by a whole name it had before while no one has it now, and says so", () => {
    const former = (a: Agent) => (a.id === "lara" ? ["Max", "allan"] : []);
    const max = parseAsk("@max hi", roster, former);
    expect(max.agent?.id).toBe("lara");
    expect(max.formerly).toEqual({ "dw/lara": "Max" });
    expect(parseAsk("@ma hi", roster, former).formerly).toEqual({});
    const allan = parseAsk("@allan hi", roster, former);
    expect(allan.agent?.id).toBe("allan");
    expect(allan.formerly).toEqual({});
  });

  it("never takes an old name over a name or id that starts with it", () => {
    const withMaxwell = [...roster, { hubId: "dw", id: "maxwell", name: "Maxwell", model: null, provider: null, isDefault: false }];
    const p = parseAsk("@max hi", withMaxwell, (a) => (a.id === "lara" ? ["Max"] : []));
    expect(p.agent?.id).toBe("maxwell");
    expect(p.matches.map((a) => a.id)).toEqual(["maxwell"]);
    expect(p.formerly).toEqual({});
  });
});
