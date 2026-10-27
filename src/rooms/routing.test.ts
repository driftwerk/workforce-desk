import { describe, expect, it } from "vitest";
import type { Agent } from "../chat/types";
import { addressees, memberKey, relay } from "./routing";

const members = [
  { hub: "dw", agent: "allan" },
  { hub: "acme", agent: "atlas" },
  { hub: "local", agent: "scout" },
];
const roster: Agent[] = [
  { hubId: "dw", id: "allan", name: "allan", model: null },
  { hubId: "acme", id: "atlas", name: "Atlas", model: null },
  { hubId: "local", id: "scout", name: "scout", model: null },
];

describe("room routing", () => {
  it("sends to everyone mentioned", () => {
    expect(addressees("@allan and @Atlas: status?", members, roster, null).map(memberKey)).toEqual(["dw/allan", "acme/atlas"]);
  });

  it("falls back to the default member", () => {
    expect(addressees("status?", members, roster, "local/scout").map(memberKey)).toEqual(["local/scout"]);
    expect(addressees("status?", members, roster, null)).toEqual([]);
  });

  it("qualifies a name with its hub and never routes an agent to itself", () => {
    expect(addressees("@allan@acme hi", members, roster, null)).toEqual([]);
    expect(addressees("@allan over to you @scout", members, roster, null, "dw/allan").map(memberKey)).toEqual(["local/scout"]);
  });

  it("relays with the room and the speaker", () => {
    expect(relay("release", "allan", "done")).toBe("[#release] allan: done");
  });
});
