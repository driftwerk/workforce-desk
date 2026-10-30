import { describe, expect, it } from "vitest";
import { deleteNote } from "./Grids";
import type { Grid } from "./model";

const grid = (contents: ({ kind: string } | null)[]): Grid =>
  ({ id: "g", name: "Release", placement: { kind: "main" }, panes: contents.map((c, i) => ({ id: `p${i}`, rect: null, content: c })) }) as unknown as Grid;

describe("deleting a grid", () => {
  it("says what happens to what's in it", () => {
    expect(deleteNote(grid([{ kind: "session" }, { kind: "agent" }, { kind: "terminal" }]))).toBe(
      "Its 2 sessions and agents stay where they are, just off this grid. Its terminal closes, with anything running in it.",
    );
    expect(deleteNote(grid([{ kind: "session" }]))).toBe("Its session or agent stays where it is, just off this grid.");
    expect(deleteNote(grid([null]))).toBe("It's empty.");
    // A session shown in place of the terminal it runs in is that terminal here.
    expect(deleteNote(grid([{ kind: "session" }, { kind: "agent" }]), 1)).toBe(
      "Its session or agent stays where it is, just off this grid. Its terminal closes, with anything running in it.",
    );
  });
});
