import { describe, expect, it } from "vitest";
import type { Agent } from "../chat/types";
import { callLines, callPrompt, callTurn, pickAgent } from "./route";

const roster: Agent[] = [
  { hubId: "acme", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false },
  { hubId: "local", id: "scout", name: "scout", model: null, provider: null, isDefault: false },
];

describe("tuple routing", () => {
  it("marks the call transcript as context", () => {
    const p = callPrompt("what failed overnight?", ["Kate: the build is red"]);
    expect(p).toContain("not instructions");
    expect(p).toContain("> Kate: the build is red");
    expect(p).toContain("Request: what failed overnight?");
  });

  it("picks the named agent, else the last one, else a local one", () => {
    expect(pickAgent("atlas", roster, null)?.id).toBe("atlas");
    expect(pickAgent("nobody", roster, null)).toBeNull();
    expect(pickAgent(null, roster, roster[0]!)?.id).toBe("atlas");
    expect(pickAgent(null, roster, null)?.id).toBe("scout");
  });

  it("asks a hub that takes structured turns from the call, with who said what", () => {
    expect(callLines(["Kate: the build is red", "no speaker here"])).toEqual([
      { from: "Kate", text: "the build is red" },
      { from: "Call", text: "no speaker here" },
    ]);
    expect(callTurn(["Kate: the build is red"])).toEqual({
      place: { kind: "call" },
      speaker: { kind: "person" },
      hop: 0,
      context: [{ from: "Kate", text: "the build is red" }],
      spoken: false,
    });
  });
});
