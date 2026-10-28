import { describe, expect, it } from "vitest";
import type { Agent } from "../chat/types";
import { addressees, memberKey, relay } from "./routing";

const members = [
  { hub: "dw", agent: "allan" },
  { hub: "acme", agent: "atlas" },
  { hub: "local", agent: "scout" },
];
const roster: Agent[] = [
  { hubId: "dw", id: "allan", name: "allan", model: null, provider: null, isDefault: false },
  { hubId: "acme", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false },
  { hubId: "local", id: "scout", name: "scout", model: null, provider: null, isDefault: false },
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

  it("reads names with punctuation after them, names with spaces, and workspaces by name", () => {
    const crew = [...roster, { hubId: "local", id: "release-captain", name: "Release Captain", model: null, provider: null, isDefault: false }];
    const room = [...members, { hub: "local", agent: "release-captain" }];
    const hubs = [{ id: "acme", label: "Acme", url: "https://acme", local: false, token: "t" }];
    expect(addressees("thanks @scout.", room, crew, null).map(memberKey)).toEqual(["local/scout"]);
    expect(addressees("@release-captain, ship it", room, crew, null).map(memberKey)).toEqual(["local/release-captain"]);
    expect(addressees("@atlas@acme hi", room, crew, null, undefined, hubs).map(memberKey)).toEqual(["acme/atlas"]);
    expect(addressees("mail allan@dw.example", room, crew, "local/scout").map(memberKey)).toEqual(["local/scout"]);
  });

  it("never routes to someone outside the room", () => {
    const outsider = { hubId: "dw", id: "ledger", name: "Ledger", model: null, provider: null, isDefault: false };
    expect(addressees("@ledger hi", members, [...roster, outsider], "local/scout").map(memberKey)).toEqual(["local/scout"]);
  });
});
