import { describe, expect, it } from "vitest";
import { emptyConversation, type ConversationState, type Turn } from "../chat/conversation";
import type { Agent, ChatMessage } from "../chat/types";
import { asked, failureIn, forModel, missingAgent, newAnswers, resolveAgent, turnsOver, voiceFor, voiceRoster, wakeNames } from "./route";

const roster: Agent[] = [
  { hubId: "acme", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false },
  { hubId: "local", id: "atlas-l", name: "Atlas", model: null, provider: null, isDefault: false },
  { hubId: "dw", id: "allan", name: "allan", model: null, provider: null, isDefault: false },
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

  it("notices a finished answer or an error, and nothing else", () => {
    const asked = conv(msg("u", "user", "what failed?"));
    const streaming = conv(msg("u", "user", "what failed?"), msg("a", "assistant", "Two", "streaming"));
    const done = conv(msg("u", "user", "what failed?"), msg("a", "assistant", "Two tests."));
    expect(newAnswers(asked, streaming, 0)).toEqual([]);
    expect(newAnswers(streaming, done, 0).map((m) => m.content)).toEqual(["Two tests."]);
    expect(newAnswers(done, done, 0)).toEqual([]);
    const failed = conv(msg("u", "user", "what failed?"), msg("e", "system", "agent unavailable", "error"));
    expect(failureIn(asked, failed)).toBe("agent unavailable");
    expect(failureIn(asked, streaming)).toBeNull();
  });

  it("doesn't take history coming in for an answer finishing", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    const old = { ...msg("h", "assistant", "From last week."), at: "2026-10-25T12:00:00Z" };
    const fresh = { ...msg("n", "assistant", "Just now."), at: "2026-11-01T12:00:01Z" };
    const under = { ...msg("s", "assistant", "Started before.", "streaming"), at: "2026-11-01T11:59:00Z" };
    const before = conv(under);
    const after = conv(old, { ...under, status: "complete" }, fresh);
    expect(newAnswers(before, after, now).map((m) => m.id)).toEqual(["s", "n"]);
  });

  const turn = (ref: string, state: Turn["state"], acked = true): Turn => ({
    ref,
    replyId: null,
    text: "",
    working: null,
    tools: [],
    attachments: [],
    state,
    acked,
  });
  const withTurns = (turns: Turn[], absorbed = 0): ConversationState => ({
    ...emptyConversation(),
    absorbed,
    turns: Object.fromEntries(turns.map((t) => [t.ref, t])),
  });

  it("knows what was said is over when its turn ends", () => {
    const since = asked(withTurns([]));
    const live = withTurns([turn("a", "live")]);
    expect(turnsOver(withTurns([]), live, since)).toBe(false);
    expect(turnsOver(live, withTurns([turn("a", "ended")]), since)).toBe(true);
    expect(turnsOver(live, withTurns([turn("a", "failed")]), since)).toBe(true);
    expect(turnsOver(withTurns([turn("a", "ended")]), withTurns([turn("a", "ended")]), since)).toBe(false);
  });

  it("waits on after a turn ends while what was said next hasn't started", () => {
    const first = withTurns([turn("a", "live")]);
    const since = asked(first);
    const queued = withTurns([turn("a", "live"), turn("b", "live", false)]);
    expect(turnsOver(queued, withTurns([turn("a", "ended"), turn("b", "live", false)]), since)).toBe(false);
    const started = withTurns([turn("a", "ended"), turn("b", "live")]);
    expect(turnsOver(started, withTurns([turn("a", "ended"), turn("b", "ended")]), since)).toBe(true);
  });

  it("ends with the live turn what was absorbed into it", () => {
    const first = withTurns([turn("a", "live")]);
    const since = asked(first);
    const absorbed = withTurns([turn("a", "live"), turn("b", "live", false)], 1);
    expect(turnsOver(absorbed, withTurns([turn("a", "ended"), turn("b", "live", false)], 1), since)).toBe(true);
  });

  it("tells a voice model when the agent it named doesn't exist", () => {
    expect(missingAgent("Scout", ["Atlas", "allan"])).toBe("There's no agent called Scout. The agents are Atlas, allan.");
    expect(missingAgent(null, ["Atlas"])).toBe("I'm not sure who that's for.");
  });

  it("gives a voice model the answer without the markdown", () => {
    expect(forModel("**Two** tests failed:\n\n```\nlog\n```")).toBe("Two tests failed: The code is in the chat.");
    const long = "A word. ".repeat(400).trim();
    expect(forModel(long)).toBe(long);
  });

  it("reads answers in the agent's own voice, else the default", () => {
    const fish = { provider: "fish_audio", voice: "802e" };
    const heart = { provider: "kokoro", voice: "af_heart" };
    const cedar = { provider: "gpt-live", voice: "cedar" };
    expect(voiceFor(roster[0]!, { "acme/atlas": heart }, fish)).toEqual(heart);
    expect(voiceFor(roster[2]!, { "acme/atlas": heart }, fish)).toEqual(fish);
    expect(voiceFor(roster[0]!, { "acme/atlas": cedar }, fish)).toEqual(fish);
  });

  it("gives the live engines each agent's live voice", () => {
    const cedar = { provider: "gpt-live", voice: "cedar" };
    const heart = { provider: "kokoro", voice: "af_heart" };
    expect(voiceRoster(roster, { "local/atlas-l": cedar, "dw/allan": heart })).toEqual([
      { name: "Atlas", voice: cedar },
      { name: "allan" },
    ]);
  });
});
