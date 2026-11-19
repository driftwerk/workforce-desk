import { describe, expect, it } from "vitest";

// app.css and crew.css share selectors (.sheet-backdrop and friends) where the
// later one wins. main.tsx imports them in that order; a component importing
// either loads it before main's import runs and flips the order (a dialog then
// sat 12vh down and ran off the bottom of the window). Only main.tsx may
// import them.
const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("global stylesheets", () => {
  it("are imported by main.tsx alone, so their order holds", () => {
    const strays = Object.entries(sources)
      .filter(([path]) => path !== "../main.tsx")
      .filter(([, text]) => /import\s+["'][./]*styles\/(app|crew)\.css["']/.test(text))
      .map(([path]) => path);
    expect(strays).toEqual([]);
    expect(Object.keys(sources)).toContain("../main.tsx");
  });
});
