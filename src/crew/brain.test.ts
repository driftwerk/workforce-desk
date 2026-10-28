import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import type { Provider } from "../hub/providers";
import { brainOf, brainSummary, isDefaultEffort, isDefaultModel, newAgentBrain, resolveBrain, withBrain, withDeskSettings } from "./brain";

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

  it("says it in a sentence", () => {
    expect(brainSummary("Ledger", { provider: "claude-code", model: "claude-code-mid", effort: "medium" }, CLAUDE)).toBe(
      "Ledger will use Mid on your Claude plan · Medium effort",
    );
    expect(brainSummary("Ledger", { provider: "openrouter", model: "openrouter-big" }, ROUTER)).toBe(
      "Ledger will use Big on your openrouter",
    );
  });
});
