import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import type { Provider } from "../hub/providers";
import { fallbackProviders } from "../providers/store";
import { defaultEffort, effortLine, effortsFor } from "../hub/providers";
import {
  brainOf,
  brainSummary,
  isDefaultBrain,
  isDefaultEffort,
  isDefaultModel,
  newAgentBrain,
  resolveBrain,
  withBrain,
  withDeskSettings,
} from "./brain";

const provider = (id: string, over: Partial<Provider> = {}): Provider => ({
  id,
  name: id === "claude-code" ? "Claude plan" : id,
  group: "plan",
  description: "",
  connected: true,
  connect: { kind: "login", fields: [] },
  models: [
    { id: `${id}-big`, name: "Big", description: "Most capable", default: false },
    { id: `${id}-mid`, name: "Mid", description: "Everyday", default: true },
  ],
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
  ...over,
});

const CLAUDE = provider("claude-code");
const CHATGPT = provider("chatgpt", { connected: false });
const ROUTER = provider("openrouter", { group: "key", efforts: [], defaultEffort: null });
const ALL = [CLAUDE, CHATGPT, ROUTER];

const llmOf = (toml: string) => (parse(toml) as Record<string, Record<string, unknown>>).llm;

const BEDROCK = provider("bedrock", {
  group: "key",
  models: [
    { id: "claude-opus", name: "Opus", description: "", default: true, provider: "bedrock:anthropic" },
    { id: "deepseek", name: "DeepSeek", description: "", default: false, provider: "bedrock:deepseek" },
  ],
});

describe("a provider whose models run under another name", () => {
  it("writes the model's own provider and reads it back as the entry", () => {
    const brain = resolveBrain({ provider: "bedrock", model: "deepseek", effort: "high" }, BEDROCK);
    const toml = withBrain("", brain);
    expect(llmOf(toml)).toMatchObject({ provider: "bedrock:deepseek", default_model: "deepseek", effort: "high" });
    expect(brainOf(toml, [CLAUDE, BEDROCK])).toEqual(brain);
  });

  it("keeps the entry id where the model runs on it", () => {
    expect(llmOf(withBrain("", resolveBrain({ provider: "claude-code" }, CLAUDE)))?.provider).toBe("claude-code");
  });
});

describe("an agent's brain in its config", () => {
  it("writes the provider, model and effort and keeps everything else", () => {
    const out = withBrain('[llm]\nmax_rounds = 20\n\n[memory]\nbackend = "sqlite"\n', {
      provider: "claude-code",
      model: "claude-code-big",
      effort: "high",
    });
    expect(llmOf(out)).toEqual({ max_rounds: 20, provider: "claude-code", default_model: "claude-code-big", effort: "high" });
    expect((parse(out) as Record<string, unknown>).memory).toEqual({ backend: "sqlite" });
  });

  it("drops the effort when the new provider has none", () => {
    const before = withBrain("", { provider: "claude-code", model: "claude-code-mid", effort: "high" });
    const after = withBrain(before, resolveBrain({ provider: "openrouter", effort: "high" }, ROUTER));
    expect(llmOf(after)).toEqual({ provider: "openrouter", default_model: "openrouter-mid" });
  });

  it("reads back what it wrote", () => {
    const brain = { provider: "chatgpt", model: "chatgpt-big", effort: "low" };
    expect(brainOf(withBrain("", brain), ALL)).toEqual(brain);
  });

  it("shows a tier name as the provider's default model", () => {
    for (const tier of ["standard", "powerful", "cheap"]) {
      const brain = brainOf(`[llm]\nprovider = "claude-code"\ndefault_model = "${tier}"\n`, ALL);
      expect(brain).toEqual({ provider: "claude-code", model: "claude-code-mid", effort: "medium" });
      expect(isDefaultModel(CLAUDE, brain.model)).toBe(true);
      expect(isDefaultEffort(CLAUDE, brain.effort)).toBe(true);
    }
  });

  it("keeps a model the provider doesn't list, and falls back to what the hub says", () => {
    expect(brainOf('[llm]\nprovider = "claude-code"\ndefault_model = "claude-custom"\neffort = "high"\n', ALL)).toEqual({
      provider: "claude-code",
      model: "claude-custom",
      effort: "high",
    });
    expect(brainOf("", ALL, { provider: "chatgpt" })).toEqual({ provider: "chatgpt", model: "chatgpt-mid", effort: "medium" });
    expect(brainOf("", [], { provider: "chatgpt", model: "gpt-6.1-sol" })).toEqual({ provider: "chatgpt", model: "gpt-6.1-sol" });
    expect(brainOf('[llm]\nprovider = "openrouter"\neffort = "high"\n', ALL)).toEqual({ provider: "openrouter", model: "openrouter-mid" });
  });

  it("writes a new agent's config with every rich block on", () => {
    const out = parse(withDeskSettings("[rich]\ncharts = false\n", { provider: "claude-code", model: "standard" })) as Record<
      string,
      Record<string, unknown>
    >;
    expect(out.llm).toEqual({ provider: "claude-code", default_model: "standard" });
    expect(out.rich!.charts).toBe(false);
    expect(out.rich!.tables).toBe(true);
  });
});

describe("where new agents start", () => {
  it("uses the saved choice, with the provider's defaults for what it leaves out", () => {
    expect(newAgentBrain({ provider: "chatgpt" }, ALL)).toEqual({ provider: "chatgpt", model: "chatgpt-mid", effort: "medium" });
    expect(newAgentBrain({ provider: "claude-code", model: "claude-code-big", effort: "high" }, ALL)).toEqual({
      provider: "claude-code",
      model: "claude-code-big",
      effort: "high",
    });
  });

  it("replaces a model or effort the provider no longer offers", () => {
    expect(newAgentBrain({ provider: "claude-code", model: "gone", effort: "xhigh" }, ALL)).toEqual({
      provider: "claude-code",
      model: "claude-code-mid",
      effort: "medium",
    });
  });

  it("starts on a connected plan when nothing is saved", () => {
    expect(newAgentBrain(null, [{ ...CLAUDE, connected: false }, { ...CHATGPT, connected: true }, ROUTER]).provider).toBe("chatgpt");
    expect(newAgentBrain(null, [{ ...CLAUDE, connected: false }, CHATGPT, ROUTER]).provider).toBe("openrouter");
    expect(newAgentBrain(null, [])).toEqual({ provider: "claude-code", model: "standard" });
  });

  it("starts on the connected plan when only the plans' logins are known", () => {
    expect(newAgentBrain(null, fallbackProviders(["codex/auth_json"]))).toEqual({ provider: "chatgpt", model: "standard" });
    expect(newAgentBrain(null, fallbackProviders(["codex/auth_json", "claude_code/oauth_token"])).provider).toBe("claude-code");
    expect(newAgentBrain(null, fallbackProviders([]))).toEqual({ provider: "claude-code", model: "standard" });
  });

  it("says it in a sentence", () => {
    expect(brainSummary("Ledger", { provider: "claude-code", model: "claude-code-mid", effort: "medium" }, CLAUDE)).toBe(
      "Ledger will use Mid on your Claude plan · Medium effort",
    );
    expect(brainSummary("Ledger", { provider: "openrouter", model: "openrouter-big" }, ROUTER)).toBe(
      "Ledger will use Big on your openrouter",
    );
  });
});

/** A provider whose models think differently: one with efforts of its own
 *  and its own default, one with none, one that follows the provider. */
const MIXED = provider("chatgpt", {
  models: [
    { id: "deep", name: "Deep", description: "", default: false, efforts: ["medium", "high", "xhigh"], defaultEffort: "high" },
    { id: "fast", name: "Fast", description: "", default: false, efforts: [] },
    { id: "plain", name: "Plain", description: "", default: true },
  ],
});

describe("effort per model", () => {
  it("takes a model's own efforts and default over the provider's", () => {
    expect(effortsFor(MIXED, "deep")).toEqual(["medium", "high", "xhigh"]);
    expect(defaultEffort(MIXED, "deep")).toBe("high");
    expect(effortsFor(MIXED, "fast")).toEqual([]);
    expect(defaultEffort(MIXED, "fast")).toBeUndefined();
    expect(effortsFor(MIXED, "plain")).toEqual(["low", "medium", "high"]);
    expect(defaultEffort(MIXED, "plain")).toBe("medium");
    expect(defaultEffort(MIXED, "not-listed")).toBe("medium");
  });

  it("falls back to the provider's default, then the first, when the model's own isn't one it offers", () => {
    const p = provider("p", {
      models: [
        { id: "a", name: "A", description: "", default: true, efforts: ["low", "medium"] },
        { id: "b", name: "B", description: "", default: false, efforts: ["high", "max"], defaultEffort: "low" },
      ],
    });
    expect(defaultEffort(p, "a")).toBe("medium");
    expect(defaultEffort(p, "b")).toBe("high");
  });

  it("resolves an effort the model doesn't offer to the model's default, and drops it where the model has none", () => {
    expect(resolveBrain({ provider: "chatgpt", model: "deep", effort: "low" }, MIXED)).toEqual({
      provider: "chatgpt",
      model: "deep",
      effort: "high",
    });
    expect(resolveBrain({ provider: "chatgpt", model: "deep", effort: "xhigh" }, MIXED).effort).toBe("xhigh");
    expect(resolveBrain({ provider: "chatgpt", model: "fast", effort: "high" }, MIXED)).toEqual({ provider: "chatgpt", model: "fast" });
    expect(resolveBrain({ provider: "chatgpt", model: "plain", effort: "xhigh" }, MIXED).effort).toBe("medium");
  });

  it("writes no effort for a model without one, and reads none back", () => {
    const before = withBrain("", { provider: "chatgpt", model: "deep", effort: "xhigh" });
    const after = withBrain(before, resolveBrain({ provider: "chatgpt", model: "fast", effort: "xhigh" }, MIXED));
    expect(llmOf(after)).toEqual({ provider: "chatgpt", default_model: "fast" });
    expect(brainOf('[llm]\nprovider = "chatgpt"\ndefault_model = "fast"\neffort = "high"\n', [MIXED])).toEqual({
      provider: "chatgpt",
      model: "fast",
    });
  });

  it("reads a config without an effort at the model's own default", () => {
    expect(brainOf('[llm]\nprovider = "chatgpt"\ndefault_model = "deep"\n', [MIXED])).toEqual({
      provider: "chatgpt",
      model: "deep",
      effort: "high",
    });
  });

  it("marks Default against the model's default effort", () => {
    expect(isDefaultEffort(MIXED, "high", "deep")).toBe(true);
    expect(isDefaultEffort(MIXED, "medium", "deep")).toBe(false);
    expect(isDefaultEffort(MIXED, "medium", "plain")).toBe(true);
    expect(effortLine(MIXED, "high", "deep")).toMatch(/The default\.$/);
    expect(effortLine(MIXED, "medium", "deep")).not.toMatch(/The default/);
    expect(isDefaultBrain(MIXED, { provider: "chatgpt", model: "plain", effort: "medium" })).toBe(true);
    expect(isDefaultBrain(MIXED, { provider: "chatgpt", model: "plain", effort: "high" })).toBe(false);
    const fastDefault = { ...MIXED, models: MIXED.models.map((m) => ({ ...m, default: m.id === "fast" })) };
    expect(isDefaultBrain(fastDefault, { provider: "chatgpt", model: "fast" })).toBe(true);
  });
});
