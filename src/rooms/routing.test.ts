import { describe, expect, it } from "vitest";
import type { Agent } from "../chat/types";
import type { RoomMessage } from "../hub/types";
import { addressees, CONTEXT_BYTES, CONTEXT_LINES, contextFor, LINE_CHARS, memberKey, relay, roomChannel } from "./routing";

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
    const hubs = [{ id: "acme", label: "Acme", url: "https://acme", local: false, revision: "t" }];
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

describe("the thread lines a member is asked with", () => {
  const at = (n: number) => `2026-10-30T10:${String(n).padStart(2, "0")}:00Z`;
  const msg = (id: string, author: string, content: string, n: number, threadId: string | null = null): RoomMessage => ({
    id,
    roomId: "r1",
    threadId,
    author,
    content,
    hop: 0,
    createdAt: at(n),
  });
  const nameOf = (a: string) => (a === "you" ? "Kingsley" : `${a.split("/")[1]} (agent)`);

  it("carries what was said since the member last spoke there, without the message being asked", () => {
    const timeline = [
      msg("1", "you", "old news", 1),
      msg("2", "dw/allan", "allan said this", 2),
      msg("3", "local/scout", "scout found a bug", 3),
      msg("4", "you", "@allan can you fix it?", 4),
      msg("t", "you", "in a thread", 5, "1"),
    ];
    expect(contextFor(timeline, "dw/allan", null, "4", nameOf)).toEqual([{ from: "scout (agent)", text: "scout found a bug" }]);
    expect(contextFor(timeline, "local/scout", null, "4", nameOf)).toEqual([]);
  });

  it("puts a thread's first message ahead, however far back it is", () => {
    const timeline = [
      msg("root", "you", "ship 0.9?", 1),
      msg("a", "dw/allan", "migration open", 2, "root"),
      msg("b", "you", "@allan done yet?", 3, "root"),
    ];
    expect(contextFor(timeline, "dw/allan", "root", "b", nameOf)).toEqual([{ from: "Kingsley", text: "ship 0.9?" }]);
  });

  it("keeps the newest lines within the hub's bounds, each line clipped", () => {
    const many = Array.from({ length: 30 }, (_, i) => msg(`m${i}`, "you", `line ${i}`, i));
    const lines = contextFor(many, "dw/allan", null, null, nameOf);
    expect(lines).toHaveLength(CONTEXT_LINES);
    expect(lines.at(-1)!.text).toBe("line 29");
    const long = contextFor([msg("x", "you", "y".repeat(2_000), 1)], "dw/allan", null, null, nameOf);
    expect([...long[0]!.text]).toHaveLength(LINE_CHARS);
    const big = Array.from({ length: 12 }, (_, i) => msg(`b${i}`, "you", "é".repeat(400), i));
    const kept = contextFor(big, "dw/allan", null, null, nameOf);
    const bytes = kept.reduce((n, l) => n + new TextEncoder().encode(l.from).length + 2 + new TextEncoder().encode(l.text).length, 0);
    expect(bytes).toBeLessThanOrEqual(CONTEXT_BYTES);
    expect(kept.at(-1)!.from).toBe("Kingsley");
  });

  it("knows a room's channel, or its slug's on an older hub", () => {
    expect(roomChannel({ slug: "release", channel: "desk:6f1c" })).toBe("desk:6f1c");
    expect(roomChannel({ slug: "release" })).toBe("desk:release");
  });
});
