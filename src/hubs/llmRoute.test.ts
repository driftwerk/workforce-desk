import { describe, expect, it } from "vitest";
import { agentView, answer, chosenModel, keptModels, optionsOf, whereDataGoes, withModel } from "./llmRoute";

describe("optionsOf", () => {
  it("keeps the workspace's own reasons", () => {
    expect(
      optionsOf({
        options: [
          { kind: "claude-code", refused: null },
          {
            kind: "codex",
            refused: "connect your own ChatGPT (Codex) login in My Settings first",
          },
          {
            kind: "devin",
            refused: "running your work on your Devin isn't available yet",
          },
        ],
      }),
    ).toEqual([
      { kind: "claude-code", refused: null },
      {
        kind: "codex",
        refused: "connect your own ChatGPT (Codex) login in My Settings first",
      },
      {
        kind: "devin",
        refused: "running your work on your Devin isn't available yet",
      },
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
    expect(
      agentView({
        available: true,
        route: null,
        every_agent: claude,
        effective: null,
      }).effective,
    ).toBeNull();
  });
});

describe("a route's models", () => {
  it("are set and cleared in an agent's own words", () => {
    const base = { kind: "codex", fallback: "wait" } as const;
    const chat = withModel(base, "conversation", "gpt-6-astra");
    expect(chat).toEqual({
      ...base,
      model_preferences: { conversation: "gpt-6-astra" },
    });
    expect(chosenModel(withModel(chat, "light", "cheap"), "light")).toBe("cheap");
    expect(withModel(chat, "conversation", undefined)).toEqual(base);
  });

  it("are kept on the same kind and dropped on another's", () => {
    const codex = {
      kind: "codex",
      fallback: "wait",
      heavy_model: "gpt-6-luna",
    } as const;
    expect(keptModels(codex, "codex")).toEqual({ heavy_model: "gpt-6-luna" });
    expect(keptModels(codex, "claude-code")).toEqual({});
  });

  it("are read from a workspace that lists them, and absent from one that doesn't", () => {
    const [listed] = optionsOf({
      options: [{ kind: "codex", refused: null, models: ["gpt-6.1-sol"] }],
    });
    expect(listed?.models).toEqual(["gpt-6.1-sol"]);
    const [older] = optionsOf({ options: [{ kind: "codex", refused: null }] });
    expect(older && "models" in older).toBe(false);
  });
});
