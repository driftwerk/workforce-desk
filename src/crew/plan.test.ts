import { describe, expect, it } from "vitest";
import type { PlannedTicket } from "../hub/types";
import progressCases from "./fixtures/plan/progress.json";
import wavesCases from "./fixtures/plan/waves.json";
import {
  awaiting,
  draftOf,
  needChoices,
  ownWorktrees,
  progress,
  progressLine,
  standing,
  waveTitle,
  waves,
  withoutTicket,
  liveCard,
  type PlanTicket,
} from "./plan";

// The hub's `plan::waves` and `plan::progress` are tested on these same
// cases (crates/desk/fixtures/plan in the hub): Desk must say the same.
describe("the plan's rules agree with the hub's", () => {
  for (const c of wavesCases.cases)
    it(`waves: ${c.name}`, () => {
      expect(waves(c.tickets as PlanTicket[])).toEqual(c.waves);
    });
  for (const c of progressCases.cases)
    it(`progress: ${c.name}`, () => {
      expect(progress(c.tickets as PlanTicket[])).toEqual(c.progress);
    });

  // Desk keeps its own copy while hub.ref is a hub without plans; once it
  // is one with them (CI checks the hub out beside Desk), a change on
  // either side shows here.
  const theirs = import.meta.glob<unknown>("../../../workforce-public-desk/crates/desk/fixtures/plan/*.json", { eager: true, import: "default" });
  const ours: Record<string, unknown> = { "waves.json": wavesCases, "progress.json": progressCases };
  it.skipIf(Object.keys(theirs).length === 0)("the copies are the hub's at hub.ref (skipped while hub.ref has no plans)", () => {
    const named = Object.fromEntries(Object.entries(theirs).map(([path, v]) => [path.split("/").pop()!, v]));
    expect(named).toEqual(ours);
  });
});

const t = (id: string, needs: string[] = [], over: Partial<PlanTicket> = {}): PlanTicket => ({ id, key: id.toUpperCase(), state: "todo", rank: 0, needs, ...over });

describe("the plan card's words", () => {
  const tickets = new Map(
    [t("a"), t("b"), t("c", ["a"]), t("d", ["b", "c"])].map((x) => [x.id, x] as const),
  );
  it("heads each wave: at once, then after what it waits on, last", () => {
    const all = [["a", "b"], ["c"], ["d"]];
    expect(waveTitle(0, all, tickets)).toEqual({ label: "Starts at once", note: "2 side by side" });
    expect(waveTitle(1, all, tickets)).toEqual({ label: "Then", note: "after A" });
    expect(waveTitle(2, all, tickets)).toEqual({ label: "Last", note: null });
    // Two waves: the second comes then, after what it needs.
    expect(waveTitle(1, [["a"], ["c"]], tickets)).toEqual({ label: "Then", note: "after A" });
    expect(waveTitle(0, [["a"]], tickets)).toEqual({ label: "Starts at once", note: null });
  });

  it("gives a worktree to a ticket beside an earlier one in the same folder", () => {
    const folders = new Map([
      ["a", { folder: "/w/web" }],
      ["b", { folder: "/w/web" }],
      ["c", { folder: "/w/api" }],
      ["d", { folder: "/w/web" }],
    ]);
    expect([...ownWorktrees([["a", "b", "c"], ["d"]], folders)]).toEqual(["b"]);
  });

  it("says where it stands", () => {
    expect(progressLine({ done: 3, doing: 3, review: 0, ready: 1, blocked: 1, waiting: 0, total: 8, next: ["ACM-16"] })).toBe("3 of 8 done · 3 running · next ACM-16 when a slot frees");
    expect(progressLine({ done: 0, doing: 0, review: 0, ready: 0, blocked: 0, waiting: 2, total: 2, next: [] })).toBe("0 of 2 done");
  });

  it("waits on the person for the first revision and for each change of scope", () => {
    const p = { state: "proposed" as const, paused: null, revision: 1, approvedRevision: null };
    expect(awaiting(p)).toBe(true);
    expect(standing(p)).toEqual({ text: "Waiting for you", look: "blocked" });
    const running = { ...p, state: "running" as const, approvedRevision: 1 };
    expect(awaiting(running)).toBe(false);
    expect(standing(running).text).toBe("Running");
    expect(standing({ ...running, revision: 2 })).toEqual({ text: "A change waits for you", look: "blocked" });
    expect(awaiting({ ...running, state: "dropped", revision: 2 })).toBe(false);
  });

  it("shows the newest card posted for a plan whole", () => {
    expect(liveCard([1, 3], 3)).toBe(true);
    expect(liveCard([1, 3], 1)).toBe(false);
    expect(liveCard([], 1)).toBe(true);
  });
});

describe("an edit", () => {
  const planned = (id: string, needs: string[] = []): PlannedTicket => ({ id, title: id, body: "", engine: "claude", folder: "/w", view: null, needs });
  it("writes a revision's tickets with their needs by place", () => {
    expect(draftOf([planned("a"), planned("b", ["a"]), planned("c", ["a", "b", "gone"])]).map((d) => d.needs)).toEqual([[], [0], [0, 1]]);
  });
  it("takes a ticket out, and what needed it no longer does", () => {
    const d = draftOf([planned("a"), planned("b", ["a"]), planned("c", ["b"])]);
    expect(withoutTicket(d, 0).map((x) => [x.id, x.needs])).toEqual([
      ["b", []],
      ["c", [0]],
    ]);
  });
  it("offers as needs only the tickets that don't need it", () => {
    const d = draftOf([planned("a"), planned("b", ["a"]), planned("c", ["b"]), planned("d")]);
    expect(needChoices(d, 0)).toEqual([3]);
    expect(needChoices(d, 2)).toEqual([0, 1, 3]);
  });
});
