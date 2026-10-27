import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { agentId, instructions, pickPlan, planOf, withDeskSettings, withName, withPurpose, withVoice } from "./local";

describe("local crew", () => {
  it("makes a unique id from a name", () => {
    expect(agentId("Release Captain!", [])).toBe("release-captain");
    expect(agentId("Release Captain", ["release-captain", "release-captain-2"])).toBe("release-captain-3");
    expect(agentId("🙂", [])).toBe("agent");
  });

  it("keeps the person's words as the instructions", () => {
    expect(instructions("Scout", "  Watch CI and tell me when it breaks. ")).toContain("Watch CI and tell me when it breaks.");
  });

  it("puts what the agent is for at the top of its soul, once", () => {
    const soul = "# SOUL.md — Who You Are\n\n## Core Identity\n\nYou are an AI agent.\n\n## Boundaries\n\n- Private things stay private\n";
    const once = withPurpose(soul, "Scout", "Watch CI.\nTell me when it breaks.");
    expect(once.indexOf("## What You're For")).toBeLessThan(once.indexOf("## Core Identity"));
    expect(once).toContain("> Watch CI.\n> Tell me when it breaks.");
    expect(once).toContain("## Boundaries");
    const again = withPurpose(once, "Scout", "Watch deploys.");
    expect(again.match(/## What You're For/g)).toHaveLength(1);
    expect(again).toContain("> Watch deploys.");
    expect(again).not.toContain("Watch CI.");
  });

  it("sets an agent's own model and reads it back", () => {
    const cfg = withDeskSettings("", "claude", "opus");
    expect(planOf(cfg)).toEqual({ plan: "claude", model: "opus" });
    expect(planOf("")).toEqual({ plan: null, model: null });
  });

  it("gives the hub an agent's voice when the hub can speak with it", () => {
    const fish = parse(withVoice("[llm]\nprovider = \"chatgpt\"\n", { provider: "fish_audio", voice: "abc" })) as Record<string, Record<string, unknown>>;
    expect(fish.llm).toEqual({ provider: "chatgpt", speech: { provider: "fish_audio", voice: "abc" } });
    const local = parse(withVoice(withVoice("", { provider: "fish_audio", voice: "abc" }), { provider: "kokoro", voice: "af_heart" })) as Record<
      string,
      Record<string, unknown>
    >;
    expect(local.llm!.speech).toBeUndefined();
  });

  it("names the agent in its identity", () => {
    expect(withName("- **Name:** \n- **Vibe:** \n", "Scout")).toBe("- **Name:** Scout\n- **Vibe:** \n");
  });

  it("uses the connected plan when none is chosen", () => {
    expect(pickPlan(null, [])).toBe("claude");
    expect(pickPlan(null, ["codex/auth_json"])).toBe("chatgpt");
    expect(pickPlan(null, ["codex/auth_json", "claude_code/oauth_token"])).toBe("claude");
    expect(pickPlan("chatgpt", ["claude_code/oauth_token"])).toBe("chatgpt");
  });

  it("sets the plan and rich blocks and keeps everything else", () => {
    const out = parse(withDeskSettings('[llm]\nmax_rounds = 20\n\n[rich]\ncharts = false\n\n[memory]\nbackend = "sqlite"\n', "chatgpt")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(out.llm).toEqual({ max_rounds: 20, provider: "chatgpt", default_model: "standard" });
    expect(out.rich!.charts).toBe(false);
    expect(out.rich!.tables).toBe(true);
    expect(out.memory).toEqual({ backend: "sqlite" });
    expect(parse(withDeskSettings("", "claude")).llm).toEqual({ provider: "claude-code", default_model: "standard" });
  });
});
