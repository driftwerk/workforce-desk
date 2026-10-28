import { describe, expect, it } from "vitest";
import { relayedTurn } from "./relayed";

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

  it("isn't anything else you typed", () => {
    expect(relayedTurn("Morgan asks: can you check staging?", crew, "Atlas")).toBeNull();
    expect(relayedTurn("what does Atlas asks: mean?", crew, "Atlas")).toBeNull();
    expect(relayedTurn("Atlas asks: ", crew, "Atlas")).toBeNull();
    expect(relayedTurn("Atlas asks: hi", [], null)).toBeNull();
  });
});
