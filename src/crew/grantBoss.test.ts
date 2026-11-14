import { describe, expect, it } from "vitest";
import type { RemoteBoss } from "../groups/remoteBoss";
import { bossOfStatus, isServed } from "./grantBoss";

const allan = (over: Partial<RemoteBoss> = {}): RemoteBoss => ({
  hub: "driftwerk",
  hubLabel: "Driftwerk",
  agent: "allan",
  party: "driftwerk/allan",
  choice: { level: "act", sees: "replies", budgetUsdPerDay: null },
  paused: false,
  pausing: false,
  stopping: false,
  waiting: 0,
  spentTodayUsd: null,
  engines: [],
  ...over,
});

describe("the boss a group's grant names", () => {
  it("is its party id and name, at its level, the roster's name first", () => {
    expect(bossOfStatus(allan(), "Allan")).toEqual({ id: "driftwerk/allan", name: "Allan", level: "act" });
    expect(bossOfStatus(allan())).toEqual({ id: "driftwerk/allan", name: "allan", level: "act" });
  });

  it("is none without one, or while it is paused, pausing or being stopped", () => {
    expect(bossOfStatus(null)).toBeNull();
    expect(bossOfStatus(allan({ paused: true }))).toBeNull();
    expect(bossOfStatus(allan({ pausing: true }))).toBeNull();
    expect(bossOfStatus(allan({ stopping: true }))).toBeNull();
  });

  it("is told from this computer's own boss by its party id", () => {
    expect(isServed({ id: "driftwerk/allan", name: "Allan", level: "act" })).toBe(true);
    expect(isServed({ id: "sarah", name: "Sarah", level: "act" })).toBe(false);
    expect(isServed(null)).toBe(false);
  });
});
