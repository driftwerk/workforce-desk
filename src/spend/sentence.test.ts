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
    expect(hear("keep me under 20 a day")).toEqual({ missing: "Say what the amount is in: “$20” or “500k tokens”." });
    expect(hear("keep me under $20")).toEqual({ missing: "Say how often: a day, a week, a month or every five hours." });
    expect(hear("$20 a day, warn at 0%")).toEqual({ missing: "Warn at a share between 1% and 99%." });
  });

  it("never takes part of a word for a name", () => {
    expect(hear("scouting under $5 a day")).toMatchObject({ budget: { scope: { kind: "desk" } } });
  });
});

describe("what Desk won't guess at", () => {
  const tricky: Known = {
    agents: [
      { id: "day", name: "Day" },
      { id: "week", name: "Week" },
      { id: "scout", name: "Scout" },
      { id: "allan", name: "Allan" },
    ],
    sessions: [{ id: "s1", name: "auth-fix" }],
    groups: [
      { id: "g-acme", name: "Acme" },
      { id: "g-other", name: "Other" },
    ],
  };
  const hear2 = (s: string) => hearBudget(s, tricky);
  const isMissing = (s: string) => expect("missing" in hear2(s), s).toBe(true);

  it("never takes a period word for a name, but hears a name said apart from it", () => {
    expect(hear2("keep me under $5 a day")).toMatchObject({ budget: { scope: { kind: "desk" }, period: "day" } });
    expect(hear2("$5 a week")).toMatchObject({ budget: { scope: { kind: "desk" }, period: "week" } });
    expect(hear2("Day under $5 a week")).toMatchObject({ budget: { scope: { kind: "agent", id: "day" }, period: "week" } });
  });

  it("gives missing for several names, a name with each, or a leaving-out", () => {
    isMissing("Scout and Allan under $5 a day");
    isMissing("Scout, each session, under $5 a day");
    isMissing("everything except Scout under $20 a day");
    isMissing("everything but not Acme under $20 a day");
    isMissing("each session in Acme and Other under $2 a day");
    isMissing("Scout in Acme under $5 a day");
    isMissing("each session and each agent under $5 a day");
  });

  it("reads amounts only when they're unambiguous, and keeps $1,000", () => {
    expect(hear2("$1,000 a month")).toMatchObject({ budget: { amount: 1000, unit: "usd" } });
    expect(hear2("$12.50 a day")).toMatchObject({ budget: { amount: 12.5 } });
    expect(hear2("1.5m tokens a week")).toMatchObject({ budget: { amount: 1_500_000, unit: "tokens" } });
    for (const s of ["$1.000 a day", "$1,5 a day", "a million dollars a day", "$1e3 a day", "$0.001 a day", "$0 a day", "$20 and 500k tokens a day", "$20 or $30 a day"]) isMissing(s);
  });

  it("gives missing for more than one period", () => {
    isMissing("$20 a day and $100 a week");
    isMissing("$20 daily, weekly");
  });

  it("understands not pausing, refuses not warning, and never quietly defaults a warning it didn't follow", () => {
    for (const s of ["$20 a day, never pause", "$20 a day, no pause", "$20 a day, don't stop"]) expect(hear2(s)).toMatchObject({ budget: { onExceed: "warn", warnAt: 0.8 } });
    expect(hear2("$20 a day, warn at 50 percent")).toMatchObject({ budget: { warnAt: 0.5 } });
    expect(hear2("$20 a day, warn me when it's at 70%")).toMatchObject({ budget: { warnAt: 0.7 } });
    for (const s of ["$20 a day, don't warn", "$20 a day, never warn me", "$20 a day, alert me at 70%", "$20 a day, 80% warn", "$20 a day, warn at 100%", "$20 a day, warn early", "$20 a day, warn at 50% and at 90%"]) isMissing(s);
  });
});

describe("what Desk says back", () => {
  it("names the group when one is said", async () => {
    const { scopeLabel, budgetLine } = await import("./budgets");
    const heard = hearBudget("everything in Acme under $50 a month", known);
    if (!("budget" in heard)) throw new Error(heard.missing);
    const names = { session: () => undefined, agent: () => undefined, group: (id: string) => known.groups.find((g) => g.id === id)?.name };
    expect(`${scopeLabel(heard.budget.scope, heard.budget.group, names)}: ${budgetLine({ ...heard.budget, warnAt: 0.8, onExceed: "pause" })}`).toBe(
      "Everything in Acme: $50 a month · warns at 80% · pauses when over",
    );
  });
});

it("says both readings of an ambiguous amount", () => {
  expect(hearBudget("$1.000 a day", known)).toEqual({ missing: "Desk can't tell whether “$1.000” is $1,000 or $1: write it as one of those." });
});
