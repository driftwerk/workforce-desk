import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNGROUPED, type Layout } from "../groups/model";
import { boardStartGroup, lastBoardGroup, rememberBoardGroup } from "./startGroup";
import { sessionNameFor } from "./board";

const layout: Layout = {
  groups: [
    { id: "g1", name: "Acme", collapsed: false, items: [] },
    { id: "g2", name: "Side", collapsed: false, items: [] },
  ],
  ungrouped: { collapsed: false, items: [] },
};

describe("the group a board's session starts in", () => {
  beforeEach(() => localStorage.clear());
  it("is the board's group, else the last chosen from a board, else Ungrouped", () => {
    expect(boardStartGroup(layout, "g1", "g2")).toBe("g1");
    expect(boardStartGroup(layout, null, "g2")).toBe("g2");
    expect(boardStartGroup(layout, null, null)).toBe(UNGROUPED);
    expect(boardStartGroup(layout, "gone", "gone")).toBe(UNGROUPED);
    expect(boardStartGroup(layout, null, UNGROUPED)).toBe(UNGROUPED);
  });
  it("remembers the last, and copes with storage that throws", () => {
    rememberBoardGroup("g2");
    expect(lastBoardGroup()).toBe("g2");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(lastBoardGroup()).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("a ticket's session name", () => {
  it("is its key and the first few words of its title", () => {
    expect(sessionNameFor({ key: "ACM-12", title: "Fix the flaky payment test on the checkout page" })).toBe("ACM-12 Fix the flaky");
    expect(sessionNameFor({ key: null, title: "Tidy up" })).toBe("Tidy up");
    expect(sessionNameFor({ key: "ACM-1", title: "Supercalifragilisticexpialidocious-unbelievably-long-single-word" }).length).toBeLessThanOrEqual(41);
  });
});
