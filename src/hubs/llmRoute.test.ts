import { describe, expect, it } from "vitest";
import { optionsOf, whereDataGoes } from "./llmRoute";

describe("optionsOf", () => {
  it("keeps the workspace's own reasons", () => {
    expect(
      optionsOf({
        options: [
          { kind: "claude-code", refused: null },
          { kind: "codex", refused: "connect your own ChatGPT (Codex) login in My Settings first" },
          { kind: "devin", refused: "running your work on your Devin isn't available yet" },
        ],
      }),
    ).toEqual([
      { kind: "claude-code", refused: null },
      { kind: "codex", refused: "connect your own ChatGPT (Codex) login in My Settings first" },
      { kind: "devin", refused: "running your work on your Devin isn't available yet" },
    ]);
  });

  it("offers what an older workspace allows, and greys out the rest", () => {
    const options = optionsOf({ allow: ["claude-code"] });
    expect(options.map((o) => o.kind)).toEqual(["claude-code", "codex", "devin"]);
    expect(options.map((o) => o.refused === null)).toEqual([true, false, false]);
  });
});

describe("whereDataGoes", () => {
  it("names who sees the conversations", () => {
    expect(whereDataGoes("claude-code", "Driftwerk")).toContain("Anthropic");
    expect(whereDataGoes(null, "Driftwerk")).toContain("Driftwerk’s own models");
  });
});
