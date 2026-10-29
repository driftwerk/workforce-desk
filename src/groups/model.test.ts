import { describe, expect, it } from "vitest";
import {
  createGroup,
  deleteGroup,
  dropAt,
  dropOn,
  EMPTY_LAYOUT,
  forgetSessions,
  groupDrop,
  groupOf,
  itemDrop,
  moveGroup,
  moveItem,
  nudgeGroup,
  nudgeItem,
  removeFromGroup,
  renameGroup,
  resolve,
  setCollapsed,
  UNGROUPED,
  type Layout,
} from "./model";

const present = ["agent:local/scout", "agent:remote/ada", "session:s1", "session:s2", "session:s3"];

const two: Layout = {
  groups: [
    { id: "acme", name: "Acme", collapsed: false, items: ["agent:local/scout", "session:s1"] },
    { id: "beta", name: "Beta", collapsed: false, items: ["session:s2", "agent:offline/zed"] },
  ],
  ungrouped: { collapsed: false, items: [] },
};

const shown = (layout: Layout, keys = present) => resolve(layout, keys).map((g) => [g.id, g.items]);

describe("the groups as shown", () => {
  it("starts with everything in Ungrouped, as it comes", () => {
    expect(shown(EMPTY_LAYOUT)).toEqual([[UNGROUPED, present]]);
  });

  it("shows each group's present items in order, Ungrouped last with the rest", () => {
    expect(shown(two)).toEqual([
      ["acme", ["agent:local/scout", "session:s1"]],
      ["beta", ["session:s2"]],
      [UNGROUPED, ["agent:remote/ada", "session:s3"]],
    ]);
  });

  it("keeps an absent item's place for when it's back", () => {
    expect(shown(two, [...present, "agent:offline/zed"])[1]).toEqual(["beta", ["session:s2", "agent:offline/zed"]]);
  });

  it("puts a new session in Ungrouped", () => {
    expect(shown(two, [...present, "session:new"]).at(-1)).toEqual([UNGROUPED, ["agent:remote/ada", "session:s3", "session:new"]]);
  });
});

describe("changing groups", () => {
  it("creates, renames and collapses a group", () => {
    let l = createGroup(EMPTY_LAYOUT, "g1", "Acme");
    l = createGroup(l, "g2", "Beta", ["session:s1"]);
    expect(l.groups.map((g) => g.name)).toEqual(["Acme", "Beta"]);
    expect(groupOf(l, "session:s1")).toBe("g2");
    l = renameGroup(l, "g1", "  Gamma ");
    expect(l.groups[0]!.name).toBe("Gamma");
    expect(renameGroup(l, "g1", "   ")).toBe(l);
    l = setCollapsed(l, "g1", true);
    l = setCollapsed(l, UNGROUPED, true);
    expect([l.groups[0]!.collapsed, l.ungrouped.collapsed]).toEqual([true, true]);
  });

  it("deleting a group sends its members to Ungrouped", () => {
    const l = deleteGroup(two, present, "acme");
    expect(l.groups.map((g) => g.id)).toEqual(["beta"]);
    expect(shown(l).at(-1)).toEqual([UNGROUPED, ["agent:remote/ada", "session:s3", "agent:local/scout", "session:s1"]]);
  });

  it("moves an item between groups and within one", () => {
    let l = moveItem(two, present, "session:s1", "beta", "session:s2");
    expect(shown(l).slice(0, 2)).toEqual([
      ["acme", ["agent:local/scout"]],
      ["beta", ["session:s1", "session:s2"]],
    ]);
    l = moveItem(l, present, "session:s1", "beta", null);
    expect(l.groups[1]!.items).toEqual(["session:s2", "agent:offline/zed", "session:s1"]);
    l = moveItem(l, present, "session:s3", "acme", "agent:local/scout");
    expect(shown(l)[0]).toEqual(["acme", ["session:s3", "agent:local/scout"]]);
  });

  it("moves an item to a place in Ungrouped, and opens a collapsed group it lands in", () => {
    let l = moveItem(two, present, "session:s1", UNGROUPED, "session:s3");
    expect(shown(l).at(-1)).toEqual([UNGROUPED, ["agent:remote/ada", "session:s1", "session:s3"]]);
    l = setCollapsed(l, "beta", true);
    l = moveItem(l, present, "session:s3", "beta", null);
    expect(l.groups[1]!.collapsed).toBe(false);
  });

  it("removes an item from its group to the end of Ungrouped", () => {
    const l = removeFromGroup(two, present, "agent:local/scout");
    expect(shown(l).at(-1)).toEqual([UNGROUPED, ["agent:remote/ada", "session:s3", "agent:local/scout"]]);
    expect(removeFromGroup(l, present, "agent:local/scout")).toBe(l);
  });

  it("reorders groups", () => {
    expect(moveGroup(two, "beta", "acme").groups.map((g) => g.id)).toEqual(["beta", "acme"]);
    expect(moveGroup(two, "acme", null).groups.map((g) => g.id)).toEqual(["beta", "acme"]);
  });
});

describe("moving from the keyboard", () => {
  it("Alt+↓ moves past the next item, then over into the next group's start", () => {
    let l = nudgeItem(two, present, "agent:local/scout", 1)!;
    expect(shown(l)[0]).toEqual(["acme", ["session:s1", "agent:local/scout"]]);
    l = nudgeItem(l, present, "agent:local/scout", 1)!;
    expect(shown(l).slice(0, 2)).toEqual([
      ["acme", ["session:s1"]],
      ["beta", ["agent:local/scout", "session:s2"]],
    ]);
  });

  it("Alt+↑ moves past the previous item, then over into the end of the group above", () => {
    let l = nudgeItem(two, present, "session:s2", -1)!;
    expect(shown(l)[0]).toEqual(["acme", ["agent:local/scout", "session:s1", "session:s2"]]);
    l = nudgeItem(two, present, "session:s3", -1)!;
    expect(shown(l).at(-1)).toEqual([UNGROUPED, ["session:s3", "agent:remote/ada"]]);
  });

  it("goes nowhere past the very top or bottom", () => {
    expect(nudgeItem(two, present, "agent:local/scout", -1)).toBeNull();
    expect(nudgeItem(two, present, "session:s3", 1)).toBeNull();
  });

  it("moves groups up and down, never past Ungrouped", () => {
    expect(nudgeGroup(two, "beta", -1)!.groups.map((g) => g.id)).toEqual(["beta", "acme"]);
    expect(nudgeGroup(two, "acme", 1)!.groups.map((g) => g.id)).toEqual(["beta", "acme"]);
    expect(nudgeGroup(two, "beta", 1)).toBeNull();
    expect(nudgeGroup(two, "acme", -1)).toBeNull();
  });
});

describe("dropping", () => {
  it("lands an item before the one under the pointer's top half, after its bottom half", () => {
    const s = resolve(two, present);
    expect(itemDrop(s, "session:s1", true)).toEqual({ kind: "item", group: "acme", before: "session:s1" });
    expect(itemDrop(s, "agent:local/scout", false)).toEqual({ kind: "item", group: "acme", before: "session:s1" });
    expect(itemDrop(s, "session:s1", false)).toEqual({ kind: "item", group: "acme", before: null });
    const l = dropOn(two, present, "session:s3", itemDrop(s, "session:s2", true)!);
    expect(shown(l)[1]).toEqual(["beta", ["session:s3", "session:s2"]]);
  });

  it("lands a group before or after another, and last over Ungrouped", () => {
    expect(groupDrop(two, "acme", true)).toEqual({ kind: "group", before: "acme" });
    expect(groupDrop(two, "acme", false)).toEqual({ kind: "group", before: "beta" });
    expect(groupDrop(two, UNGROUPED, true)).toEqual({ kind: "group", before: null });
    expect(dropOn(two, present, "beta", groupDrop(two, "acme", true)).groups.map((g) => g.id)).toEqual(["beta", "acme"]);
  });
});

describe("where a drag lands", () => {
  const s = resolve(two, present);
  const item = (id: string) => ({ type: "item" as const, id });
  const group = (id: string) => ({ type: "group" as const, id });

  it("an item over an item: before or after it; over a group: its end", () => {
    expect(dropAt(two, s, item("session:s3"), item("session:s1"), true)).toEqual({ kind: "item", group: "acme", before: "session:s1" });
    expect(dropAt(two, s, item("session:s3"), group("beta"), true)).toEqual({ kind: "item", group: "beta", before: null });
    expect(dropAt(two, s, item("agent:remote/ada"), group(UNGROUPED), false)).toEqual({ kind: "item", group: UNGROUPED, before: null });
  });

  it("nothing where the item already is", () => {
    expect(dropAt(two, s, item("session:s1"), item("session:s1"), true)).toBeNull();
    expect(dropAt(two, s, item("session:s1"), item("agent:local/scout"), false)).toBeNull();
    expect(dropAt(two, s, item("agent:local/scout"), item("session:s1"), true)).toBeNull();
    expect(dropAt(two, s, item("session:s1"), group("acme"), true)).toBeNull();
    expect(dropAt(two, s, item("agent:local/scout"), item("session:s1"), false)).toEqual({ kind: "item", group: "acme", before: null });
  });

  it("a group over a group: before or after it, nothing where it is, and never over an item", () => {
    expect(dropAt(two, s, group("beta"), group("acme"), true)).toEqual({ kind: "group", before: "acme" });
    expect(dropAt(two, s, group("acme"), group(UNGROUPED), true)).toEqual({ kind: "group", before: null });
    expect(dropAt(two, s, group("acme"), group("beta"), true)).toBeNull();
    expect(dropAt(two, s, group("beta"), group(UNGROUPED), true)).toBeNull();
    expect(dropAt(two, s, group("acme"), item("session:s2"), true)).toBeNull();
  });
});

describe("forgetting sessions that are gone", () => {
  it("takes them out of every group and forgets their names, leaving agents", () => {
    const l = { ...two, ungrouped: { collapsed: false, items: ["session:s3"] } };
    const out = forgetSessions(l, { s1: "release", s9: "old" }, (id) => id === "s1" || id === "s3" || id === "s9")!;
    expect(out.layout.groups[0]!.items).toEqual(["agent:local/scout"]);
    expect(out.layout.ungrouped.items).toEqual([]);
    expect(out.names).toEqual({});
    expect(forgetSessions(two, {}, (id) => id === "nope")).toBeNull();
  });
});
