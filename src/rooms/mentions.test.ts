import { describe, expect, it } from "vitest";
import type { Agent, HubAccount } from "../chat/types";
import { handle, insertMention, mentionAt, mentionFor, parseMentions, resolveMentions, suggestions } from "./mentions";

const agent = (hubId: string, id: string, name: string): Agent => ({ hubId, id, name, model: null, provider: null, isDefault: false });
const hubs: HubAccount[] = [
  { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" },
  { id: "workforce-example-com", label: "Driftwerk", url: "https://workforce.example.com", local: false, revision: "t" },
];
const roster = [
  agent("local", "scout", "Scout"),
  agent("local", "release-captain", "Release Captain"),
  agent("local", "allan", "allan"),
  agent("workforce-example-com", "allan", "allan"),
  agent("workforce-example-com", "atlas", "Atlas"),
];

describe("parsing mentions", () => {
  it("leaves punctuation after a name out of it", () => {
    expect(parseMentions("thanks @scout. And @atlas, @allan!")).toEqual([{ name: "scout" }, { name: "atlas" }, { name: "allan" }]);
  });

  it("reads a name qualified with its workspace", () => {
    expect(parseMentions("@allan@driftwerk go")).toEqual([{ name: "allan", hub: "driftwerk" }]);
  });

  it("doesn't take an email address for a mention", () => {
    expect(parseMentions("mail kings@example.com or @scout")).toEqual([{ name: "scout" }]);
  });

  it("writes a name with spaces as one word", () => {
    expect(handle("Release Captain")).toBe("release-captain");
    expect(handle(" J.R. ")).toBe("j.r");
  });
});

describe("who a message names", () => {
  const members = [{ hub: "local", agent: "scout" }];

  it("tells members from crew who aren't in the room yet", () => {
    const r = resolveMentions("@scout and @release-captain, @atlas: ready?", members, roster, hubs);
    expect(r.members).toEqual([{ hub: "local", agent: "scout" }]);
    expect(r.outsiders.map((a) => a.id)).toEqual(["release-captain", "atlas"]);
    expect(r.ambiguous).toEqual([]);
  });

  it("can't tell which of two of the same name is meant without their workspace", () => {
    expect(resolveMentions("@allan hi", members, roster, hubs).ambiguous).toEqual(["allan"]);
    const r = resolveMentions("@allan@driftwerk hi", members, roster, hubs);
    expect(r.outsiders).toEqual([roster[3]]);
    expect(resolveMentions("@allan@workforce-example-com hi", members, roster, hubs).outsiders).toEqual([roster[3]]);
  });

  it("prefers the member when only one of the same name is in the room", () => {
    const r = resolveMentions("@allan hi", [{ hub: "local", agent: "allan" }], roster, hubs);
    expect(r).toEqual({ members: [{ hub: "local", agent: "allan" }], outsiders: [], ambiguous: [] });
  });

  it("ignores names nobody has", () => {
    expect(resolveMentions("@nobody hi", members, roster, hubs)).toEqual({ members: [], outsiders: [], ambiguous: [] });
  });
});

describe("the @ list as you type", () => {
  it("finds the @ being typed at the caret", () => {
    expect(mentionAt("hey @sc", 7)).toEqual({ start: 4, query: "sc" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("hey @sc", 3)).toBeNull();
    expect(mentionAt("kings@exa", 9)).toBeNull();
    expect(mentionAt("hey @scout and", 14)).toBeNull();
  });

  it("offers members first, matching any word of a name", () => {
    expect(suggestions("", roster, [{ hub: "workforce-example-com", agent: "atlas" }]).map((a) => a.id)[0]).toBe("atlas");
    expect(suggestions("cap", roster, []).map((a) => a.id)).toEqual(["release-captain"]);
    expect(suggestions("al", roster, []).map((a) => a.hubId)).toEqual(["local", "workforce-example-com"]);
  });

  it("replaces what was typed with the mention and a space", () => {
    expect(insertMention("hey @sc thanks", 4, 7, "scout")).toEqual({ text: "hey @scout thanks", caret: 11 });
    expect(insertMention("@", 0, 1, "scout")).toEqual({ text: "@scout ", caret: 7 });
    expect(insertMention("@scmore", 0, 3, "scout")).toEqual({ text: "@scout ", caret: 7 });
  });

  it("writes a mention that names exactly the one picked", () => {
    for (const a of roster) {
      const { text } = insertMention("@", 0, 1, mentionFor(a, roster, hubs));
      const r = resolveMentions(`${text}please.`, [], roster, hubs);
      expect(r.outsiders).toEqual([a]);
      expect(r.ambiguous).toEqual([]);
    }
    expect(mentionFor(roster[1]!, roster, hubs)).toBe("release-captain");
    expect(mentionFor(roster[3]!, roster, hubs)).toBe("allan@driftwerk");
  });
});
