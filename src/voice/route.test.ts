import { describe, expect, it } from "vitest";
import { emptyConversation, type ConversationState } from "../chat/conversation";
import type { Agent, ChatMessage } from "../chat/types";
import { acknowledgement, forModel, missingAgent, outcome, resolveAgent, wakeNames } from "./route";

const roster: Agent[] = [
  { hubId: "acme", id: "atlas", name: "Atlas", model: null },
  { hubId: "local", id: "atlas-l", name: "Atlas", model: null },
  { hubId: "dw", id: "allan", name: "allan", model: null },
];

const msg = (id: string, role: ChatMessage["role"], content: string, status: ChatMessage["status"] = "complete"): ChatMessage => ({
  id,
  role,
  content,
  status,
  at: "",
  tools: [],
});

const conv = (...messages: ChatMessage[]): ConversationState => ({ ...emptyConversation(), messages });

describe("voice routing", () => {
  it("wakes on each name once", () => {
    expect(wakeNames(roster)).toEqual(["Atlas", "allan"]);
  });

  it("sends a named request to that agent, local first", () => {
    expect(resolveAgent("Atlas", roster, null, null)?.id).toBe("atlas-l");
    expect(resolveAgent("allan", roster, roster[0]!, null)?.id).toBe("allan");
    expect(resolveAgent("nobody", roster, roster[0]!, null)).toBeNull();
  });

  it("sends a follow-up to whoever is being talked to, else the open DM", () => {
    expect(resolveAgent(null, roster, roster[2]!, "acme/atlas")?.id).toBe("allan");
    expect(resolveAgent(null, roster, null, "acme/atlas")?.id).toBe("atlas");
    expect(resolveAgent(null, roster, null, null)).toBeNull();
  });

  it("varies the acknowledgement", () => {
    expect(acknowledgement("Atlas", 0)).toBe("On it.");
    expect(acknowledgement("Atlas", 1)).toBe("Atlas's on it.");
    expect(acknowledgement("Atlas", 5)).toBe("Working on it.");
  });

  it("notices a finished answer or an error, and nothing else", () => {
    const asked = conv(msg("u", "user", "what failed?"));
    const streaming = conv(msg("u", "user", "what failed?"), msg("a", "assistant", "Two", "streaming"));
    const done = conv(msg("u", "user", "what failed?"), msg("a", "assistant", "Two tests."));
    expect(outcome(asked, streaming)).toBeNull();
    expect(outcome(streaming, done)).toEqual({ kind: "answer", text: "Two tests." });
    expect(outcome(done, done)).toBeNull();
    const failed = conv(msg("u", "user", "what failed?"), msg("e", "system", "agent unavailable", "error"));
    expect(outcome(asked, failed)).toEqual({ kind: "error", text: "agent unavailable" });
  });

  it("tells a voice model when the agent it named doesn't exist", () => {
    expect(missingAgent("Scout", ["Atlas", "allan"])).toBe("There's no agent called Scout. The agents are Atlas, allan.");
    expect(missingAgent(null, ["Atlas"])).toBe("I'm not sure who that's for.");
  });

  it("gives a voice model the answer without the markdown", () => {
    expect(forModel("**Two** tests failed:\n\n```\nlog\n```")).toBe("Two tests failed: I've put the details in Desk.");
    expect(forModel("word ".repeat(400)).length).toBeLessThan(1_600);
  });
});
