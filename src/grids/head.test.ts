import { describe, expect, it } from "vitest";
import { HEAD_DROPS, headParts, nameParts } from "./head";

// The stylesheet as written (Vitest hands CSS imports over empty). Node's
// types aren't in this project's, so it's reached untyped.
const fs = (await import("node:fs" as string)) as { readFileSync: (path: string, enc: "utf8") => string };
const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
const css = fs.readFileSync(`${cwd}/src/styles/grids.css`, "utf8");

describe("a pane's header as it narrows", () => {
  it("gives way where a terminal is first, then what the pane is, then the badge; the name stays", () => {
    expect(headParts(900)).toEqual(["cwd", "meta", "badge"]);
    expect(headParts(560)).toEqual(["meta", "badge"]);
    expect(headParts(440)).toEqual(["badge"]);
    expect(headParts(340)).toEqual([]);
    expect(headParts(120)).toEqual([]);
    // Each part is gone before the next, at any width.
    for (let w = 0; w <= 900; w += 10) {
      const shown = headParts(w);
      expect(HEAD_DROPS.map((d) => d.part).slice(HEAD_DROPS.length - shown.length)).toEqual(shown);
    }
  });

  it("is hidden by grids.css's container queries at those widths", () => {
    const queries = [...css.matchAll(/@container gpane-head \(max-width: (\d+)px\) \{\s*\.gpane-(\w+) \{\s*display: none;/g)].map(([, at, part]) => ({
      part,
      upTo: Number(at),
    }));
    expect(queries).toEqual(HEAD_DROPS);
  });

  it("cuts a long name in the middle, keeping its start and end", () => {
    expect(nameParts("api-e7")).toEqual(["api-e7", ""]);
    expect(nameParts("invoice totals")).toEqual(["invoice totals", ""]);
    const [start, end] = nameParts("checkout-redirect-loop-7f3a");
    expect(start + end).toBe("checkout-redirect-loop-7f3a");
    expect(end).toBe("oop-7f3a");
    // Never through a character.
    expect(nameParts("launch day 🚀rockets")).toEqual(["launch day ", "🚀rockets"]);
  });
});
