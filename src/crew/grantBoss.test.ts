import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remoteBosses, type BossEngine, type RemoteBoss } from "../groups/remoteBoss";
import { bossOfStatus, isServed, useGrantBosses } from "./grantBoss";

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

const engine = (live: boolean | null): BossEngine => ({
  engine: "local",
  name: "This computer",
  linked: true,
  sessions: 1,
  live,
  why: live === false ? "Its grant expired." : null,
  enginePaused: false,
  stopped: false,
  expiresAt: null,
  reachedAt: null,
  problem: null,
  belowFull: [],
  spentTodayUsd: null,
});

describe("the boss a group's grant names", () => {
  it("is its party id and name, at its level, the roster's name first", () => {
    expect(bossOfStatus(allan(), "Allan")).toEqual({ id: "driftwerk/allan", name: "Allan", level: "act", served: true });
    expect(bossOfStatus(allan())).toEqual({ id: "driftwerk/allan", name: "allan", level: "act", served: true });
  });

  it("is none without one, while it is paused, pausing or being stopped, or where no engine's grant serves it", () => {
    expect(bossOfStatus(null)).toBeNull();
    expect(bossOfStatus(allan({ paused: true }))).toBeNull();
    expect(bossOfStatus(allan({ pausing: true }))).toBeNull();
    expect(bossOfStatus(allan({ stopping: true }))).toBeNull();
    expect(bossOfStatus(allan({ engines: [engine(false), engine(false)] }))).toBeNull();
    expect(bossOfStatus(allan({ engines: [engine(false), engine(true)] }))).not.toBeNull();
    expect(bossOfStatus(allan({ engines: [engine(null)] }))).not.toBeNull();
  });

  it("is told from this computer's own boss by being named by a grant", () => {
    expect(isServed(bossOfStatus(allan()))).toBe(true);
    expect(isServed({ id: "sarah", name: "Sarah", level: "act" })).toBe(false);
    expect(isServed(null)).toBe(false);
  });
});

describe("the groups' bosses, read", () => {
  beforeEach(() => useGrantBosses.setState({ byGroup: {}, bossed: {}, readAt: {} }));
  afterEach(() => vi.restoreAllMocks());

  it("are read once at a time, and not again while fresh", async () => {
    const status = vi.spyOn(remoteBosses, "status").mockResolvedValue(allan());
    useGrantBosses.getState().ensure("acme");
    useGrantBosses.getState().ensure("acme");
    await vi.waitFor(() => expect(useGrantBosses.getState().byGroup.acme?.id).toBe("driftwerk/allan"));
    useGrantBosses.getState().ensure("acme");
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("are not asked again at once after a read that failed, and keep what was read", async () => {
    useGrantBosses.setState({ byGroup: { acme: bossOfStatus(allan()) }, bossed: { acme: true }, readAt: { acme: 0 } });
    const status = vi.spyOn(remoteBosses, "status").mockRejectedValue(new Error("unreachable"));
    useGrantBosses.getState().ensure("acme");
    await vi.waitFor(() => expect(useGrantBosses.getState().readAt.acme).toBeGreaterThan(0));
    useGrantBosses.getState().ensure("acme");
    expect(status).toHaveBeenCalledTimes(1);
    expect(useGrantBosses.getState().byGroup.acme?.id).toBe("driftwerk/allan");
  });

  it("never lay an older read over a fresher one the Boss sheet heard", async () => {
    let answer: (s: RemoteBoss | null) => void = () => {};
    vi.spyOn(remoteBosses, "status").mockReturnValue(new Promise((r) => (answer = r)));
    useGrantBosses.getState().ensure("acme");
    useGrantBosses.getState().heard("acme", allan({ paused: true }));
    answer(allan());
    await new Promise((r) => setTimeout(r, 0));
    expect(useGrantBosses.getState().byGroup.acme).toBeNull();
    expect(useGrantBosses.getState().bossed.acme).toBe(true);
  });

  it("never read the ungrouped", () => {
    const status = vi.spyOn(remoteBosses, "status");
    useGrantBosses.getState().ensure("ungrouped");
    expect(status).not.toHaveBeenCalled();
  });
});
