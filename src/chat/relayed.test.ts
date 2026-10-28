import { describe, expect, it } from "vitest";
import { relayedOf, relayedTurn } from "./relayed";
import type { Author, ChatMessage } from "./types";

const crew = ["Atlas", "atlas", "Scout", "scout", "Ops", "Ops Lead"];

describe("a turn the overseer sent on", () => {
  it("is from the overseer it names, asking or handing out a task", () => {
    expect(relayedTurn("Atlas asks: How is the staging check going?", crew, "Atlas")).toEqual({
      by: "overseer",
      overseer: "Atlas",
      task: false,
      text: "How is the staging check going?",
    });
    expect(relayedTurn("Atlas has a task for you: Update the release notes.", crew, "Atlas")).toEqual({
      by: "overseer",
      overseer: "Atlas",
      task: true,
      text: "Update the release notes.",
    });
  });

  it("names the overseer it was then, by its id where it had no name, and the longest name that fits", () => {
    expect(relayedTurn("Scout asks: and the docs?", crew, "Atlas")?.overseer).toBe("Scout");
    expect(relayedTurn("atlas asks: and the docs?", crew, null)?.overseer).toBe("atlas");
    expect(relayedTurn("Ops Lead asks: anything stuck?", crew, null)?.overseer).toBe("Ops Lead");
  });

  it("is yours, through the overseer, when it's a suggestion you said yes to", () => {
    expect(relayedTurn("You asks: Restart the stuck build.", crew, "Atlas")).toEqual({
      by: "you",
      overseer: "Atlas",
      task: false,
      text: "Restart the stuck build.",
    });
    expect(relayedTurn("You has a task for you: Tidy the backlog.", crew, null)).toMatchObject({ by: "you", task: true, overseer: "the overseer" });
  });

  it("is yours when it's worded with your name, or as the person the agent works for", () => {
    expect(relayedTurn("Sam asks: Restart the stuck build.", crew, "Atlas", "Sam")).toMatchObject({ by: "you", text: "Restart the stuck build." });
    expect(relayedTurn("The person you work for has a task for you: Tidy up.", crew, null)).toMatchObject({ by: "you", task: true, text: "Tidy up." });
    expect(relayedTurn("Sam asks: Restart the stuck build.", crew, "Atlas")).toBeNull();
  });

  it("isn't anything else you typed", () => {
    expect(relayedTurn("Morgan asks: can you check staging?", crew, "Atlas")).toBeNull();
    expect(relayedTurn("what does Atlas asks: mean?", crew, "Atlas")).toBeNull();
    expect(relayedTurn("Atlas asks: ", crew, "Atlas")).toBeNull();
    expect(relayedTurn("Atlas asks: hi", [], null)).toBeNull();
  });
});

describe("who sent a DM message on, as the hub says", () => {
  const said = (content: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
    id: "h1",
    role: "user",
    content,
    at: "2026-10-28T09:00:00Z",
    status: "complete",
    tools: [],
    ...over,
  });
  const atlas: Author = { kind: "overseer", id: "atlas", name: "Atlas" };
  const you: Author = { kind: "you", id: "you", name: "You" };
  const here = { local: true, crew, overseer: "Atlas", person: "Sam" };
  const away = { local: false, crew: [], overseer: null, person: null };

  it("is the overseer it names, on any hub, without its wording", () => {
    expect(relayedOf(said("Atlas asks: How is staging?", { author: atlas }), away)).toEqual({
      by: "overseer",
      overseer: "Atlas",
      task: false,
      text: "How is staging?",
    });
    expect(relayedOf(said("Atlas has a task for you: Bob asks: what now?", { author: atlas }), away)).toMatchObject({
      task: true,
      text: "Bob asks: what now?",
    });
    // Renamed since: the wording is still taken off.
    expect(relayedOf(said("Old Name has a task for you: Tidy up.", { author: atlas }), away)).toMatchObject({
      overseer: "Atlas",
      task: true,
      text: "Tidy up.",
    });
  });

  it("is yours through the overseer when it came live as yours", () => {
    expect(relayedOf(said("Sam asks: Restart the build.", { author: you, sentOn: true }), here)).toEqual({
      by: "you",
      overseer: "Atlas",
      task: false,
      text: "Restart the build.",
    });
    expect(relayedOf(said("Someone asks: Restart it.", { author: you, sentOn: true }), away)).toEqual({
      by: "you",
      overseer: "the overseer",
      task: false,
      text: "Restart it.",
    });
  });

  it("is told by its wording, on this Mac, where the hub doesn't say or says it's yours", () => {
    expect(relayedOf(said("Atlas asks: and the docs?"), here)).toMatchObject({ by: "overseer", overseer: "Atlas" });
    expect(relayedOf(said("Atlas asks: and the docs?", { author: you }), here)).toMatchObject({ by: "overseer" });
    expect(relayedOf(said("Sam asks: Restart the build.", { author: you }), here)).toMatchObject({ by: "you", text: "Restart the build." });
    expect(relayedOf(said("Atlas asks: and the docs?", { author: you }), away)).toBeNull();
  });

  it("isn't anything you typed, or anything not yours", () => {
    expect(relayedOf(said("Morgan asks: can you check staging?", { author: you }), here)).toBeNull();
    expect(relayedOf(said("Atlas asks: hi", { role: "assistant", author: atlas }), here)).toBeNull();
    expect(relayedOf(said("Atlas asks: hi", { author: { kind: "agent", id: "scout", name: "Scout" } }), here)).toBeNull();
  });
});
