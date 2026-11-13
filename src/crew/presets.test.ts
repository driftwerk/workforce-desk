import { describe, expect, it } from "vitest";
import { DEFAULT_OVERSIGHT, isUnbound, type Oversight } from "./oversight";
import { ACT_SWITCHES, PRESETS, presetOf, withPreset } from "./presets";
import { budgetFrom, foldersOf, fromFacts, PLAN_ONLY_BUDGET_USD, repoName, withoutCredentials } from "./suggest";
import { MAX_FULL_BUDGET_USD } from "./oversight";
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
    // Act fully is unbound: every switch on, anywhere.
    const full = withPreset(DEFAULT_OVERSIGHT, "full");
    expect(full).toMatchObject({ level: "full", full: { anywhere: true } });
    expect(Object.values(full.act).every((on) => on)).toBe(true);
    expect(isUnbound(full)).toBe(true);
    // Whatever its switches and lists say.
    expect(isUnbound({ ...full, act: { ...ACT_SWITCHES }, full: { ...full.full, anywhere: false, repos: ["acme/a"] } })).toBe(true);
    expect(isUnbound(act)).toBe(false);
    // From Act fully back to Act: Act's switches again.
    expect(withPreset(full, "act")).toMatchObject({ act: ACT_SWITCHES, full: { anywhere: false } });
  });

  it("a switch changed by hand is no preset, below Act the switches don't matter", () => {
    const act = withPreset(DEFAULT_OVERSIGHT, "act");
    expect(presetOf({ ...act, act: { ...act.act, setMode: true } })).toBeNull();
    expect(presetOf({ ...withPreset(DEFAULT_OVERSIGHT, "suggest"), act: { ...act.act, setMode: true } })).toBe("suggest");
    expect(presetOf({ ...withPreset(DEFAULT_OVERSIGHT, "full"), act: { ...ACT_SWITCHES } })).toBe("full");
  });

  it("keeps repos, workflows and budget", () => {
    const o = at({ full: { anywhere: false, repos: ["acme/acme-web"], workflows: ["deploy.yml"], budgetUsdPerDay: 25 } });
    expect(withPreset(o, "act").full).toEqual({ anywhere: false, repos: ["acme/acme-web"], workflows: ["deploy.yml"], budgetUsdPerDay: 25 });
    expect(withPreset(o, "full").full).toEqual({ anywhere: true, repos: ["acme/acme-web"], workflows: ["deploy.yml"], budgetUsdPerDay: 25 });
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

  it("never keeps credentials from a remote, and leaves out what the hub wouldn't take", () => {
    expect(withoutCredentials("https://oauth2:glpat-SECRET@gitlab.example.com/acme/web.git")).toBe("https://gitlab.example.com/acme/web.git");
    expect(withoutCredentials("tok:SECRET@gitlab.example.com:acme/web.git")).toBe("gitlab.example.com:acme/web.git");
    expect(withoutCredentials("git@gitlab.example.com:acme/web.git")).toBe("git@gitlab.example.com:acme/web.git");
    expect(repoName("https://oauth2:glpat-SECRET@gitlab.example.com/acme/web.git")).toBe("https://gitlab.example.com/acme/web.git");
    expect(repoName("https://x-access-token:ghs_SECRET@github.com/acme/web.git")).toBe("acme/web");
    // A page under a repo is that repo.
    expect(repoName("https://ghp_SECRET@github.com/acme/web/tree/main")).toBe("acme/web");
    const s = fromFacts([
      { folder: "/w/a", top: "/r/a", remote: "https://oauth2:glpat-SECRET@gitlab.example.com/acme/web.git", workflows: [] },
      { folder: "/w/b", top: "/r/b", remote: "file:///srv/git/b.git", workflows: [".hidden.yml", "123.yml", "deploy.yaml"] },
      { folder: "/w/c", top: "rel/c/d", remote: null, workflows: Array.from({ length: 30 }, (_, i) => `w${i}.yml`) },
    ]);
    expect(s.repos).toEqual(["https://gitlab.example.com/acme/web.git"]);
    expect(JSON.stringify(s)).not.toContain("SECRET");
    expect(s.workflows).toHaveLength(20);
    expect(s.workflows).toContain("deploy.yaml");
    expect(s.workflows).not.toContain("123.yml");
    expect(s.workflows).not.toContain(".hidden.yml");
  });

  it("budgets from metered spend only, and a plan-only crew gets a cap for API spend", () => {
    expect(budgetFrom(null)).toEqual({ usd: PLAN_ONLY_BUDGET_USD, metered: false });
    // Plans bill nobody; a mixed account can't be split, so neither counts.
    expect(budgetFrom(view([row(400, ["plan"]), row(30, ["plan", "key"])]))).toEqual({ usd: PLAN_ONLY_BUDGET_USD, metered: false });
    // $35 metered in a week: $5 a day, twice that.
    expect(budgetFrom(view([row(20, ["key"]), row(15, ["vendor"]), row(400, ["plan"])]))).toEqual({ usd: 10, metered: true });
    expect(budgetFrom(view([row(1, ["key"])]))).toEqual({ usd: 5, metered: true });
    expect(budgetFrom(view([row(1_000_000, ["key"])]))).toEqual({ usd: MAX_FULL_BUDGET_USD, metered: true });
  });

  it("reads folders from this computer's sessions and the month's spend, each once", () => {
    const s = (cwd: string, machine?: string) => ({ cwd, machine }) as Session;
    expect(foldersOf([s("/a"), s("/b", "devbox"), s("/a")], view([row(1, ["plan"], "/c"), row(1, ["plan"], "/a")]))).toEqual(["/a", "/c"]);
  });
});

describe("why a level isn't in force", () => {
  const full = withPreset(DEFAULT_OVERSIGHT, "full");
  it("needs no repos or switches: only today's spend holds it", () => {
    expect(causeOf(full, false, null)).toBeNull();
    const ready = { ...full, full: { ...full.full, repos: ["acme/a"], budgetUsdPerDay: 20 } };
    expect(causeOf(ready, false, null)).toBeNull();
    expect(causeOf(ready, true, null)).toEqual({ kind: "unread" });
    expect(causeOf(ready, true, view([row(25, ["key"])]))).toEqual({ kind: "spent", spentUsd: 25, budgetUsd: 20 });
    // An older hub counts plans' calls too: that reaching it is said.
    expect(causeOf(ready, true, view([row(5, ["key"]), row(30, ["plan"])]))).toEqual({ kind: "spent", spentUsd: 35, budgetUsd: 20 });
    // Its switches short of every one: still in force.
    expect(causeOf({ ...full, act: { ...ACT_SWITCHES } }, false, null)).toBeNull();
    expect(causeOf(withPreset(DEFAULT_OVERSIGHT, "act"), true, null)).toBeNull();
    expect(spentToday(view([row(5, ["key"]), row(30, ["plan"])]))).toEqual({ metered: 5, all: 35 });
    // The hub's own count of real money wins: plans never reach it.
    const plans = view([row(5, ["key"]), row(1000, ["plan"])]);
    expect(causeOf(ready, true, plans, { spentUsd: 5, budgetUsd: 20, spent: false })).toEqual({ kind: "unread" });
    expect(causeOf(ready, false, plans, { spentUsd: 5, budgetUsd: 20, spent: false })).toBeNull();
    expect(causeOf(ready, true, null, { spentUsd: 21, budgetUsd: 20, spent: true })).toEqual({ kind: "spent", spentUsd: 21, budgetUsd: 20 });
  });

  it("raises a spent budget with room for today", () => {
    expect(raisedBudget(25, 20)).toBe(40);
    expect(raisedBudget(20, 20)).toBe(30);
    expect(raisedBudget(1, 20)).toBe(25);
    expect(raisedBudget(50_000, MAX_FULL_BUDGET_USD)).toBe(MAX_FULL_BUDGET_USD);
  });
});
