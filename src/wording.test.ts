import { describe, expect, it } from "vitest";

/** Every source file Desk ships, as text. */
const sources = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** A line may name the Mac only beside the macOS case it is for
 *  (`platform === "macos"`, or a `macos:` entry of a per-platform text). */
const macOnly = /\bmacos\b/;

describe("wording", () => {
  it("says this computer, not this Mac, wherever Desk runs", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    const found = Object.entries(sources).flatMap(([file, text]) =>
      text
        .split("\n")
        .map((line, i) => `${file}:${i + 1}: ${line.trim()}`)
        .filter((line) => /\bMacs?\b/.test(line.slice(line.indexOf(": ") + 2)) && !macOnly.test(line)),
    );
    expect(found).toEqual([]);
  });
});
