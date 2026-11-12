import { describe, expect, it } from "vitest";
import { hearBudget, type Known } from "./sentence";

const known: Known = {
  agents: [
    { id: "scout", name: "Scout" },
    { id: "allan", name: "Allan" },
  ],
  sessions: [{ id: "s1", name: "auth-fix" }],
  groups: [
    { id: "g-acme", name: "Acme" },
    { id: "g-acme-web", name: "Acme Web" },
  ],
};
const hear = (s: string) => hearBudget(s, known);

describe("a budget said in a sentence", () => {
  it("keeps me under $20 a day: everything, pausing after the turn, warning at 80%", () => {
    expect(hear("keep me under $20 a day")).toEqual({
      budget: { scope: { kind: "desk" }, group: null, period: "day", unit: "usd", amount: 20, warnAt: 0.8, onExceed: "pause" },
    });
  });

  it("hears each session or agent, a named agent or session, and a group", () => {
    expect(hear("each session under 500k tokens a week")).toMatchObject({
      budget: { scope: { kind: "each_session" }, unit: "tokens", amount: 500_000, period: "week" },
    });
    expect(hear("Every agent: no more than 12.50 dollars monthly")).toMatchObject({
      budget: { scope: { kind: "each_agent" }, unit: "usd", amount: 12.5, period: "month" },
    });
    expect(hear("Scout no more than $5 a day")).toMatchObject({ budget: { scope: { kind: "agent", id: "scout" }, group: null } });
    expect(hear("auth-fix under $3 per day")).toMatchObject({ budget: { scope: { kind: "session", id: "s1" } } });
    expect(hear("everything in Acme Web under $50 a month")).toMatchObject({ budget: { scope: { kind: "desk" }, group: "g-acme-web" } });
    expect(hear("each session in Acme, $2 every five hours")).toMatchObject({
      budget: { scope: { kind: "each_session" }, group: "g-acme", period: "five_hours" },
    });
  });

  it("hears only warn, and when to warn", () => {
    expect(hear("$20 a day, just warn")).toMatchObject({ budget: { onExceed: "warn" } });
    expect(hear("$20 a day, warn me at 90%")).toMatchObject({ budget: { warnAt: 0.9, onExceed: "pause" } });
  });

  it("says what's missing rather than guessing", () => {
    expect(hear("")).toEqual({ missing: "Say how much, and how often: “keep me under $20 a day”." });
    expect(hear("keep me under twenty a day")).toEqual({ missing: "Say how much: “$20” or “500k tokens”." });
    expect(hear("keep me under $20")).toEqual({ missing: "Say how often: a day, a week, a month or every five hours." });
    expect(hear("$20 a day, warn at 0%")).toEqual({ missing: "Warn at a share between 1% and 99%." });
  });

  it("never takes part of a word for a name", () => {
    expect(hear("scouting under $5 a day")).toMatchObject({ budget: { scope: { kind: "desk" } } });
  });
});
