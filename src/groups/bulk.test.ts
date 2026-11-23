import { describe, expect, it, vi } from "vitest";
import { cannot, tally, talliedEntry } from "./bulk";

describe("acting on picked rows together", () => {
  it("puts the rows' choices together by label, in the order first offered", () => {
    const [stopA, stopB, resume] = [vi.fn(), vi.fn(), vi.fn()];
    const t = tally([[{ label: "Stop", run: stopA }], [], [{ label: "Resume", run: resume }, { label: "Stop", run: stopB }]]);
    expect(t.map((x) => [x.label, x.runs.length])).toEqual([
      ["Stop", 2],
      ["Resume", 1],
    ]);
    expect(tally([])).toEqual([]);
  });

  it("says how many each choice is for and how many can't, and does it for each", () => {
    const [a, b] = [vi.fn(), vi.fn()];
    const entry = talliedEntry({ label: "Stop", runs: [a, b] }, 3);
    expect(entry).toMatchObject({ kind: "item", label: "Stop 2 sessions", hint: "1 can’t" });
    if (entry.kind === "item") entry.onSelect?.();
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
    expect(talliedEntry({ label: "Resume", runs: [a] }, 1)).toMatchObject({ label: "Resume 1 session", hint: undefined });
  });

  it("says a choice for several as it asks to be said", () => {
    const run = vi.fn();
    const [read] = tally([[{ label: "Mark read", run, counted: (n) => `Mark ${n} read` }], [{ label: "Mark read", run, counted: (n) => `Mark ${n} read` }]]);
    expect(talliedEntry(read!, 4)).toMatchObject({ label: "Mark 2 read", hint: "2 can’t" });
  });

  it("says nothing when every row can", () => {
    expect(cannot(3, 3)).toBeUndefined();
    expect(cannot(3, 5, "removed")).toBe("2 can’t be removed");
  });
});
