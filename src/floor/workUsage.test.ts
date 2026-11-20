import { describe, expect, it } from "vitest";
import type { WorkUsage } from "../hub/types";
import { inWeek, percent, planUse, windowWord } from "./workUsage";

const w = (day: WorkUsage["day"], week: WorkUsage["week"]) => ({ day, week });

describe("planUse", () => {
  it("says the weekly share, today's, and the turns", () => {
    expect(
      planUse(
        w(
          {
            turns: 12,
            tokens: 1,
            shares: [{ plan: "claude", windowMinutes: 10080, share: 0.8 }],
          },
          {
            turns: 80,
            tokens: 1,
            shares: [
              { plan: "claude", windowMinutes: 10080, share: 4.2 },
              { plan: "claude", windowMinutes: 300, share: 12 },
            ],
          },
        ),
      ),
    ).toBe("4.2% of your weekly Claude plan this week · 0.8% today · 80 turns");
  });
  it("uses the longest window, and today's share of that same window", () => {
    const s = planUse(
      w(
        {
          turns: 3,
          tokens: 1,
          shares: [{ plan: "chatgpt", windowMinutes: 300, share: 9 }],
        },
        {
          turns: 1,
          tokens: 1,
          shares: [{ plan: "chatgpt", windowMinutes: 300, share: 9 }],
        },
      ),
    );
    expect(s).toBe(
      "9% of your five-hour ChatGPT plan this week · 9% today · 1 turn",
    );
  });
  it("says only turns without shares", () => {
    expect(
      planUse(
        w(
          { turns: 12, tokens: 0, shares: [] },
          { turns: 80, tokens: 0, shares: [] },
        ),
      ),
    ).toBe("12 turns today · 80 this week");
  });
  it("says under 0.1% for a trace", () => {
    expect(
      planUse(
        w(
          { turns: 0, tokens: 0, shares: [] },
          {
            turns: 2,
            tokens: 0,
            shares: [{ plan: "claude", windowMinutes: 10080, share: 0.04 }],
          },
        ),
      ),
    ).toBe(
      "under 0.1% of your weekly Claude plan this week · none today · 2 turns",
    );
  });
});

describe("words", () => {
  it("rounds to one decimal", () => {
    expect(percent(4.24)).toBe("4.2%");
    expect(percent(4.26)).toBe("4.3%");
    expect(percent(0.06)).toBe("under 0.1%");
    expect(percent(0.1)).toBe("0.1%");
    expect(percent(0.049)).toBe("under 0.1%");
  });
  it("keeps a work with a share but no turns, drops one with neither", () => {
    const of = (work: string, share: number): WorkUsage => ({
      work,
      label: work,
      agentId: "atlas",
      kind: "monitor",
      day: { turns: 0, tokens: 0, shares: [] },
      week: {
        turns: 0,
        tokens: 0,
        shares: [{ plan: "claude", windowMinutes: 10080, share }],
      },
    });
    const quiet = of("monitor:a", 0);
    const shared = of("monitor:b", 0.5);
    expect(inWeek([quiet, shared])).toEqual([shared]);
  });
  it("names windows", () => {
    expect(windowWord(10080)).toBe("weekly");
    expect(windowWord(300)).toBe("five-hour");
    expect(windowWord(180)).toBe("3-hour");
    expect(windowWord(2880)).toBe("2-day");
  });
});
