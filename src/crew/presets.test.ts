import { describe, expect, it } from "vitest";
import { DEFAULT_OVERSIGHT, fullMissing, isUnbound, type Oversight } from "./oversight";
import { ACT_SWITCHES, PRESETS, presetOf, withPreset } from "./presets";
import { budgetFrom, foldersOf, fromFacts, PLAN_ONLY_BUDGET_USD, repoName } from "./suggest";
import { causeOf, raisedBudget, spentToday } from "./WhyNotInForce";
import type { Session, SpendRow, SpendView } from "../hub/types";

const at = (o: Partial<Oversight>): Oversight => ({ ...DEFAULT_OVERSIGHT, ...o });

describe("presets", () => {
  it("each level sets its own switches, and reads back as itself", () => {
    for (const p of PRESETS) {
      const o = withPreset(DEFAULT_OVERSIGHT, p);
      expect(o.enabled).toBe(true);
      expect(presetOf(o)).toBe(p);
    }
    const act = withPreset(DEFAULT_OVERSIGHT, "act");
    expect(act.level).toBe("act");
    // Act does the work inside Desk; what reaches outside it stays the person's.
    expect(act.act).toEqual(ACT_SWITCHES);
    expect(act.act).toMatchObject({ handOutWork: true, interrupt: true, readOnlyApprovals: true, answerSessions: true });
    expect(act.act).toMatchObject({ messageAgents: false, messageTerminalSessions: false, handOff: false, setMode: false });
    expect(withPreset(DEFAULT_OVERSIGHT, "full")).toMatchObject({ level: "full", act: ACT_SWITCHES, full: { anywhere: false } });
    expect(isUnbound(withPreset(DEFAULT_OVERSIGHT, "unbound"))).toBe(true);
    // From Unbound back to Act fully: limited to its repos again.
    expect(withPreset(withPreset(DEFAULT_OVERSIGHT, "unbound"), "full").full.anywhere).toBe(false);
  });

  it("a switch changed by hand is no preset, below Act the switches don't matter", () => {
    const act = withPreset(DEFAULT_OVERSIGHT, "act");
    expect(presetOf({ ...act, act: { ...act.act, setMode: true } })).toBeNull();
    expect(presetOf({ ...withPreset(DEFAULT_OVERSIGHT, "suggest"), act: { ...act.act, setMode: true } })).toBe("suggest");
  });

  it("keeps repos, workflows and budget", () => {
    const o = at({ full: { anywhere: false, repos: ["acme/acme-web"], workflows: ["deploy.yml"], budgetUsdPerDay: 25 } });
    expect(withPreset(o, "full").full).toEqual({ anywhere: false, repos: ["acme/acme-web"], workflows: ["deploy.yml"], budgetUsdPerDay: 25 });
  });
});

const row = (usd: number, billing: SpendRow["totals"]["billing"], folder: string | null = null): SpendRow => ({
  key: String(Math.random()),
  label: "x",
  session: null,
  engine: null,
  folder,
  totals: { tokens: {} as never, usd, calls: 1, unpricedCalls: 0, unpricedModels: [], billing },
});
const view = (rows: SpendRow[]): SpendView =>
  ({ from: "", to: "", by: "account", total: { ...rows[0]?.totals, usd: rows.reduce((s, r) => s + r.totals.usd, 0) }, rows, more: 0 }) as SpendView;

describe("Act fully's suggestions", () => {
  it("names a GitHub remote owner/name, another host by its address, a folder without one", () => {
    expect(repoName("git@github.com:acme/acme-web.git")).toBe("acme/acme-web");
    expect(repoName("https://github.com/acme/acme-api.git")).toBe("acme/acme-api");
    expect(repoName("ssh://git@github.com/acme/tools")).toBe("acme/tools");
    expect(repoName("git@gitlab.example.com:acme/x.git")).toBe("git@gitlab.example.com:acme/x.git");
    const s = fromFacts([
      { folder: "/w/a", top: "/r/a", remote: "git@github.com:acme/a.git", workflows: ["deploy.yml", "ci.yml"] },
      { folder: "/w/a2", top: "/r/a2", remote: "https://github.com/acme/a", workflows: ["deploy.yml"] },
      { folder: "/w/b", top: "/r/b", remote: null, workflows: [] },
    ]);
    expect(s).toEqual({ repos: ["acme/a", "/r/b"], workflows: ["ci.yml", "deploy.yml"] });
  });

  it("budgets from metered spend only, and a plan-only crew gets a cap for API spend", () => {
    expect(budgetFrom(null)).toEqual({ usd: PLAN_ONLY_BUDGET_USD, metered: false });
    // Plans bill nobody; a mixed account can't be split, so neither counts.
    expect(budgetFrom(view([row(400, ["plan"]), row(30, ["plan", "key"])]))).toEqual({ usd: PLAN_ONLY_BUDGET_USD, metered: false });
    // $35 metered in a week: $5 a day, twice that.
    expect(budgetFrom(view([row(20, ["key"]), row(15, ["vendor"]), row(400, ["plan"])]))).toEqual({ usd: 10, metered: true });
    expect(budgetFrom(view([row(1, ["key"])]))).toEqual({ usd: 5, metered: true });
  });

  it("reads folders from this computer's sessions and the month's spend, each once", () => {
    const s = (cwd: string, machine?: string) => ({ cwd, machine }) as Session;
    expect(foldersOf([s("/a"), s("/b", "devbox"), s("/a")], view([row(1, ["plan"], "/c"), row(1, ["plan"], "/a")]))).toEqual(["/a", "/c"]);
  });
});

describe("why a level isn't in force", () => {
  const full = withPreset(DEFAULT_OVERSIGHT, "full");
  it("names what's missing first, then Unbound's switches, then today's spend", () => {
    expect(causeOf(full, false, null)).toEqual({ kind: "needs", missing: ["repos", "budget"] });
    const ready = { ...full, full: { ...full.full, repos: ["acme/a"], budgetUsdPerDay: 20 } };
    expect(fullMissing(ready)).toEqual([]);
    expect(causeOf(ready, false, null)).toBeNull();
    expect(causeOf(ready, true, null)).toEqual({ kind: "unread" });
    expect(causeOf(ready, true, view([row(25, ["key"])]))).toEqual({ kind: "spent", spentUsd: 25, budgetUsd: 20 });
    // An older hub counts plans' calls too: that reaching it is said.
    expect(causeOf(ready, true, view([row(5, ["key"]), row(30, ["plan"])]))).toEqual({ kind: "spent", spentUsd: 35, budgetUsd: 20 });
    const anywhere = { ...withPreset(DEFAULT_OVERSIGHT, "unbound"), act: { ...ACT_SWITCHES } };
    expect(causeOf(anywhere, false, null)).toEqual({ kind: "switches" });
    expect(causeOf(withPreset(DEFAULT_OVERSIGHT, "act"), true, null)).toBeNull();
    expect(spentToday(view([row(5, ["key"]), row(30, ["plan"])]))).toEqual({ metered: 5, all: 35 });
  });

  it("raises a spent budget with room for today", () => {
    expect(raisedBudget(25, 20)).toBe(40);
    expect(raisedBudget(20, 20)).toBe(30);
    expect(raisedBudget(1, 20)).toBe(25);
  });
});
