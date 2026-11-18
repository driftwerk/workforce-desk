import { describe, expect, it } from "vitest";
import { agentView, answer, optionsOf, whereDataGoes } from "./llmRoute";

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

describe("a workspace from before routes", () => {
  it("reads as missing, not as a failure", async () => {
    expect((await answer(new Response("", { status: 404 }), true)).missing).toBe(true);
    await expect(answer(new Response("", { status: 404 }))).rejects.toThrow("404");
    await expect(answer(new Response(JSON.stringify({ error: "no" }), { status: 500 }))).rejects.toThrow("no");
  });

  it("works out what an agent runs on when it doesn't say", () => {
    const claude = { kind: "claude-code", fallback: "wait" } as const;
    expect(agentView({ available: true, route: null, every_agent: claude }).effective).toEqual(claude);
    expect(agentView({ available: true, route: "hub", every_agent: claude }).effective).toBeNull();
    expect(agentView({ available: true, route: null, every_agent: claude, effective: null }).effective).toBeNull();
  });
});
