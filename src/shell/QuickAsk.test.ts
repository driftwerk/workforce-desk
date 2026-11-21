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

  it("lists an agent by a whole old name beside one whose name starts with it, and picks the whole one", () => {
    const withMaxine = [...roster, { hubId: "dw", id: "maxine", name: "maxine", model: null, provider: null, isDefault: false }];
    const p = parseAsk("@max hi", withMaxine, (a) => (a.id === "lara" ? ["Max"] : []));
    expect(p.matches.map((a) => a.id)).toEqual(["maxine", "lara"]);
    expect(p.agent?.id).toBe("lara");
  });
});
