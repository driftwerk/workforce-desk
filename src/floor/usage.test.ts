import { describe, expect, it } from "vitest";
import type { PlanReading, UsageView } from "../hub/types";
import { fullness, nextChange, pace, plans, projection, windowNow, type PlanSource } from "./usage";
import { NOW, at } from "./testing";

const MIN = 60_000;
const later = (min: number) => new Date(NOW + min * MIN).toISOString();
const five = (used: number, resetsIn: number) => ({ usedPercent: used, resetsAt: later(resetsIn), minutes: 300 });

const reading = (over: Partial<PlanReading> = {}): PlanReading => ({
  kind: "claude",
  where: "mac",
  account: "acct-1",
  plan: "max",
  windows: [five(62, 148)],
  observedAt: at(1),
  ...over,
});

const source = (hubId: string, usage: Partial<UsageView>, over: Partial<PlanSource> = {}): PlanSource => ({
  hubId,
  label: `Hub ${hubId}`,
  local: hubId === "local",
  usage: { asOf: at(0), logins: [], readings: [], ...usage },
  offset: 0,
  ...over,
});

describe("plan cards", () => {
  it("are one per account, the freshest reading shown, with the plan where any said it", () => {
    const cards = plans([
      source("local", { readings: [reading({ observedAt: at(10) })] }),
      source("b", { readings: [reading({ where: "hub", plan: null, observedAt: at(2), windows: [five(70, 148)] })] }),
    ]);
    const claude = cards.filter((c) => c.kind === "claude");
    expect(claude).toHaveLength(1);
    expect(claude[0]).toMatchObject({ state: "reading", plan: "max", where: "Hub b" });
    expect(claude[0]!.reading!.windows[0]!.usedPercent).toBe(70);
  });

  it("are two for two accounts of one kind, each said where", () => {
    const cards = plans([source("local", { readings: [reading()] }), source("b", { readings: [reading({ account: "acct-2", where: "hub" })] })]);
    expect(cards.filter((c) => c.kind === "claude").map((c) => c.where)).toEqual(["this Mac", "Hub b"]);
  });

  it("put a reading with no account with the only card of its kind, else on its own", () => {
    const one = plans([source("local", { readings: [reading({ observedAt: at(5) })] }), source("b", { readings: [reading({ account: null, where: "hub" })] })]);
    expect(one.filter((c) => c.kind === "claude")).toHaveLength(1);
    const two = plans([
      source("local", { readings: [reading(), reading({ account: "acct-2", where: "hub" })] }),
      source("b", { readings: [reading({ account: null, where: "hub" })] }),
    ]);
    expect(two.filter((c) => c.kind === "claude")).toHaveLength(3);
  });

  it("wait for a reading while signed in, and offer sign-in on this Mac only", () => {
    const signedIn = plans([source("b", { logins: [{ kind: "chatgpt", where: "hub", signedIn: true }] })]);
    expect(signedIn).toEqual([expect.objectContaining({ kind: "chatgpt", state: "no-reading", where: "Hub b" })]);
    const local = plans([source("local", { logins: [{ kind: "chatgpt", where: "mac", signedIn: false }], readings: [reading()] })]);
    expect(local.map((c) => [c.kind, c.state])).toEqual([
      ["claude", "reading"],
      ["chatgpt", "signed-out"],
    ]);
    expect(plans([source("b", { logins: [{ kind: "chatgpt", where: "hub", signedIn: false }] })])).toEqual([]);
  });

  it("show a hub's times in this Mac's clock", () => {
    const [card] = plans([source("b", { readings: [reading({ where: "hub" })] }, { offset: 60_000 })]);
    expect(card!.reading!.observedAt).toBe(at(2));
    expect(card!.reading!.windows[0]!.resetsAt).toBe(later(147));
  });
});

describe("a plan window", () => {
  it("is full from 90%, high from 60%", () => {
    expect([59, 60, 89, 90].map(fullness)).toEqual(["ok", "high", "high", "full"]);
  });

  it("counts for nothing once it resets, or when its reading is from before its window", () => {
    expect(windowNow(five(62, 30), at(1), NOW)).toEqual({ used: 62, resetAt: NOW + 30 * MIN, reset: false });
    expect(windowNow(five(95, -1), at(10), NOW)).toMatchObject({ used: 0, reset: true });
    expect(windowNow(five(40, 30), at(400), NOW)).toMatchObject({ used: 0, reset: true });
  });

  it("knows where an even pace would be", () => {
    expect(pace(five(10, 150), NOW)).toBeCloseTo(0.5);
    expect(pace(five(10, 400), NOW)).toBe(0);
    expect(pace({ usedPercent: 10, resetsAt: null, minutes: 300 }, NOW)).toBeNull();
  });

  it("projects the limit only once it can tell, and only before the reset", () => {
    expect(projection(five(5, 295), NOW)).toBeNull();
    expect(projection(five(80, 150), NOW)).toEqual({ hitsAt: NOW + (20 / (80 / (150 * MIN))) });
    expect(projection(five(20, 150), NOW)).toBeNull();
    expect(projection(five(100, 30), NOW)).toEqual({ atLimit: true });
    expect(projection(five(100, -1), NOW)).toBeNull();
  });

  it("changes next at the soonest reset to come", () => {
    const cards = plans([source("local", { readings: [reading({ windows: [five(10, 30), five(10, -5), { usedPercent: 1, resetsAt: later(900), minutes: 10_080 }] })] })]);
    expect(nextChange(cards, NOW)).toBe(NOW + 30 * MIN);
    expect(nextChange([], NOW)).toBeNull();
  });
});
