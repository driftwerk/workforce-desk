import { afterEach, describe, expect, it, vi } from "vitest";
import { useChat } from "./store";
import { describeAgent, yourRoute, type Agent, type HubAccount, type PersonalRouteShown } from "./types";

const fetches = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../hub/net", async (original) => ({
  ...(await original<typeof import("../hub/net")>()),
  pairedHub: () => fetches,
}));

const patchwork: HubAccount = { id: "pw", label: "Patchwork", url: "https://hub.example.com", local: false, revision: "t" };
const lattice: Agent = { hubId: "pw", id: "lattice", name: "Lattice", model: "us.anthropic.claude-opus-4-8", provider: "bedrock", isDefault: false };
const claude = (over: Partial<PersonalRouteShown> = {}): PersonalRouteShown => ({
  kind: "claude-code",
  title: "Claude",
  model: "claude-opus-4-8",
  fallback: "wait",
  connected: true,
  ...over,
});

afterEach(() => useChat.setState({ hubs: [], roster: [], rosterErrors: {}, settling: {} }));

describe("What an agent is said to run on for you", () => {
  it("is the hub's provider and model while your turns run on the hub's models", () => {
    expect(describeAgent(lattice, "Patchwork")).toBe("Patchwork · AWS Bedrock · us.anthropic.claude-opus-4-8");
    expect(describeAgent({ ...lattice, personalRoute: null }, "Patchwork")).toBe("Patchwork · AWS Bedrock · us.anthropic.claude-opus-4-8");
  });

  it("is your own plan and its model when your turns run on it", () => {
    expect(describeAgent({ ...lattice, personalRoute: claude() }, "Patchwork")).toBe(
      "Patchwork · Your Claude plan · claude-opus-4-8 · stops if your plan can’t take a turn",
    );
    expect(describeAgent({ ...lattice, personalRoute: claude({ kind: "codex", title: "ChatGPT (Codex)", model: "gpt-5.3-codex" }) }, "Patchwork")).toBe(
      "Patchwork · Your ChatGPT plan (Codex) · gpt-5.3-codex · stops if your plan can’t take a turn",
    );
  });

  it("says where a turn your plan can't take goes, when that is the hub's models", () => {
    expect(describeAgent({ ...lattice, personalRoute: claude({ fallback: "hub" }) }, "Patchwork")).toBe(
      "Patchwork · Your Claude plan · claude-opus-4-8 · falls back to AWS Bedrock",
    );
  });

  it("without your login, is the hub's when turns fall back to it, and says not connected when they wait", () => {
    expect(describeAgent({ ...lattice, personalRoute: claude({ connected: false, fallback: "hub" }) }, "Patchwork")).toBe(
      "Patchwork · AWS Bedrock · us.anthropic.claude-opus-4-8",
    );
    expect(describeAgent({ ...lattice, personalRoute: claude({ connected: false, fallback: "wait" }) }, "Patchwork")).toBe(
      "Patchwork · Your Claude plan (not connected) · claude-opus-4-8 · waits until you connect it",
    );
    expect(yourRoute({ ...lattice, personalRoute: claude({ connected: false }) })?.label).toBe("Your Claude plan (not connected)");
  });
});

describe("A route that can't run here", () => {
  it("says so, and why, rather than claiming your plan takes the turn", () => {
    const refused = "running your work on your ChatGPT (Codex) needs this hub's coding worker, and it has none";
    expect(
      describeAgent({ ...lattice, personalRoute: claude({ kind: "codex", title: "ChatGPT (Codex)", model: "gpt-5.3-codex", refused }) }, "Patchwork"),
    ).toBe(`Patchwork · Your ChatGPT plan (Codex), which can’t run here · ${refused}`);
  });
});

describe("The agent list", () => {
  it("reads your own route where the hub says it, and nothing where it doesn't or says it oddly", async () => {
    useChat.setState({ hubs: [patchwork], roster: [] });
    fetches.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        agents: [
          { id: "lattice", provider: "bedrock", model: "m", personal_route: { kind: "claude-code", title: "Claude", model: "opus", fallback: "hub", connected: true } },
          { id: "scout", provider: "bedrock", model: "m" },
          { id: "codex", provider: "bedrock", model: "m", personal_route: { kind: "codex", title: "ChatGPT (Codex)", model: "gpt-5.3-codex", fallback: "wait", connected: false } },
          { id: "odd", provider: "bedrock", model: "m", personal_route: { kind: "claude-code", fallback: "sometimes" } },
          { id: "partial", provider: "bedrock", model: "m", personal_route: { kind: "claude-code", model: "opus", fallback: "hub" } },
          { id: "refused", provider: "bedrock", model: "m", personal_route: { kind: "codex", title: "ChatGPT (Codex)", model: "gpt-5.3-codex", fallback: "wait", connected: true, refused: "needs a worker" } },
          { id: "blank", provider: "bedrock", model: "m", personal_route: { kind: "claude-code", model: " ", fallback: "wait", connected: true } },
        ],
      }),
    });
    await useChat.getState().refreshRoster();
    const byId = Object.fromEntries(useChat.getState().roster.map((a) => [a.id, a.personalRoute]));
    expect(byId.lattice).toEqual({ kind: "claude-code", title: "Claude", model: "opus", fallback: "hub", connected: true });
    expect(byId.scout).toBeNull();
    expect(byId.codex).toEqual({ kind: "codex", title: "ChatGPT (Codex)", model: "gpt-5.3-codex", fallback: "wait", connected: false });
    expect(byId.refused?.refused).toBe("needs a worker");
    expect(byId.lattice?.refused).toBeUndefined();
    expect(byId.odd).toBeNull();
    expect(byId.partial).toBeNull();
    expect(byId.blank).toBeNull();
  });
});
