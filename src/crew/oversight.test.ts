import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERSIGHT,
  fullMissing,
  oversightOf,
  parseBudget,
  parseCheckins,
  parseHold,
  parseMinutes,
  parseParallel,
  parseRepo,
  parseTime,
  parseWorkflow,
  readable,
  withOversight,
} from "./oversight";

const CONFIG = `[llm]
provider = "claude-code"
default_model = "claude-sonnet-5-5"

[rich]
charts = true
`;

describe("[oversight] in an agent's config", () => {
  it("reads and writes Act fully's repos, workflows and budget, and the hold, as the hub does", () => {
    const o = oversightOf(
      `${CONFIG}\n[oversight]\nenabled = true\nlevel = "full"\nwake = { hold_minutes = 5 }\n[oversight.full]\nrepos = ["acme/acme-web", " ~/dev/globex-api ", "acme/acme-web"]\nworkflows = ["deploy.yml", "123.yml", ".github/workflows/x.yml"]\nbudget_usd_per_day = 25\n`,
    );
    expect(o.level).toBe("full");
    expect(o.wake.holdMinutes).toBe(5);
    expect(o.full).toEqual({ repos: ["acme/acme-web", "~/dev/globex-api"], workflows: ["deploy.yml"], budgetUsdPerDay: 25 });
    expect(fullMissing(o)).toEqual([]);
    const written = parse(withOversight(CONFIG, { ...o, full: { ...o.full, budgetUsdPerDay: 7.5 } })) as {
      oversight: { level: string; wake: { hold_minutes: number }; full: Record<string, unknown> };
    };
    expect(written.oversight.level).toBe("full");
    expect(written.oversight.wake.hold_minutes).toBe(5);
    expect(written.oversight.full).toEqual({ repos: ["acme/acme-web", "~/dev/globex-api"], workflows: ["deploy.yml"], budget_usd_per_day: 7.5 });
    // Nothing of Act fully set: no table written; a budget never set stays absent.
    expect("full" in (parse(withOversight(CONFIG, DEFAULT_OVERSIGHT)) as { oversight: object }).oversight).toBe(false);
    const noBudget = { ...DEFAULT_OVERSIGHT, level: "full" as const, full: { repos: ["acme/acme-web"], workflows: [], budgetUsdPerDay: null } };
    expect((parse(withOversight(CONFIG, noBudget)) as { oversight: { full: object } }).oversight.full).toEqual({ repos: ["acme/acme-web"], workflows: [] });
    expect(fullMissing(noBudget)).toEqual(["budget"]);
    expect(fullMissing({ ...DEFAULT_OVERSIGHT, level: "full" })).toEqual(["repos", "budget"]);
    // What the hub would refuse reads as the defaults.
    const bad = oversightOf(`[oversight]\nwake = { hold_minutes = 61 }\n[oversight.full]\nbudget_usd_per_day = 0\n`);
    expect(bad.wake.holdMinutes).toBe(2);
    expect(bad.full.budgetUsdPerDay).toBeNull();
  });

  it("checks repos, workflows, a budget and the hold as typed, in the hub's words", () => {
    for (const ok of ["acme/acme-web", "git@github.com:acme/acme-web.git", "https://github.com/acme/acme-web", "gitlab.com/acme/acme-web", "~/dev/acme-web", "/Users/sam/dev/acme-web"]) {
      expect(parseRepo(ok), ok).toEqual({ value: ok });
    }
    for (const bad of ["acme", "", "acme web/x", "https://github.com/acme"]) {
      expect("problem" in parseRepo(bad), bad).toBe(true);
    }
    expect(parseRepo("acme/acme-web", ["acme/acme-web"])).toEqual({ problem: "That repo is already named." });
    expect(parseWorkflow("deploy.yml")).toEqual({ value: "deploy.yml" });
    expect(parseWorkflow("promote.yaml")).toEqual({ value: "promote.yaml" });
    for (const bad of ["deploy", "123.yml", ".yml", "..yml", "a b.yml", "ci/deploy.yml", "deploy.yml.txt"]) {
      expect(parseWorkflow(bad), bad).toEqual({ problem: "The workflows it may run must be a list of up to 20 file names like deploy.yml." });
    }
    expect(parseBudget("25")).toEqual({ value: 25 });
    expect(parseBudget("$7.50")).toEqual({ value: 7.5 });
    for (const bad of ["0", "-5", "10001", "ten", "1.234"]) {
      expect(parseBudget(bad), bad).toEqual({ problem: "Its daily budget must be an amount in dollars above 0 and up to 10000." });
    }
    expect(parseHold("2")).toEqual({ value: 2 });
    for (const bad of ["0", "61", "1.5", ""]) {
      expect(parseHold(bad), bad).toEqual({
        problem: "How long your typing in a session keeps it yours must be a whole number of minutes from 1 to 60.",
      });
    }
  });

  it("is off with the defaults when the file says nothing", () => {
    expect(oversightOf(CONFIG)).toEqual(DEFAULT_OVERSIGHT);
    expect(oversightOf("")).toEqual(DEFAULT_OVERSIGHT);
    expect(DEFAULT_OVERSIGHT.enabled).toBe(false);
  });

  it("reads what the file says, inline tables included", () => {
    const o = oversightOf(`[oversight]
enabled = true
level = "act"
track = { crew = true, desk_sessions = false, external_sessions = true, workspaces = true }
wake = { waiting_minutes = 10, quiet_minutes = 0, on_finish = false, on_failure = true, on_message = false }
summaries = { morning = "08:30", evening = "" }
max_checkins_per_hour = 3
max_checkins_per_day = 12
act = { nudge = false, resume_restart = true, read_only_approvals = true, hand_out_work = false, interrupt = true, answer_sessions = false }
`);
    expect(o).toEqual({
      enabled: true,
      group: null,
      level: "act",
      track: { crew: true, deskSessions: false, externalSessions: true, workspaces: true },
      wake: { waitingMinutes: 10, quietMinutes: 0, onFinish: false, onFailure: true, onMessage: false, holdMinutes: 2 },
      summaries: { morning: "08:30", evening: "" },
      maxCheckinsPerHour: 3,
      maxCheckinsPerDay: 12,
      act: {
        nudge: false,
        resumeRestart: true,
        readOnlyApprovals: true,
        handOutWork: false,
        interrupt: true,
        messageAgents: false,
        messageTerminalSessions: false,
        answerSessions: false,
      },
      work: { preferSessions: true, parallel: 4, takeOn: "handed", engine: "claude", maxTurnsPerHour: 60 },
      full: { repos: [], workflows: [], budgetUsdPerDay: null },
    });
  });

  it("answers sessions' questions and wakes on them unless switched off, as the hub reads it", () => {
    expect(DEFAULT_OVERSIGHT.act.answerSessions).toBe(true);
    expect(DEFAULT_OVERSIGHT.wake.onMessage).toBe(true);
    expect(oversightOf("[oversight]\nenabled = true\n").act.answerSessions).toBe(true);
    const off = withOversight(CONFIG, { ...DEFAULT_OVERSIGHT, act: { ...DEFAULT_OVERSIGHT.act, answerSessions: false }, wake: { ...DEFAULT_OVERSIGHT.wake, onMessage: false } });
    const doc = parse(off) as { oversight: { act: Record<string, unknown>; wake: Record<string, unknown> } };
    expect(doc.oversight.act.answer_sessions).toBe(false);
    expect(doc.oversight.wake.on_message).toBe(false);
  });

  it("uses the default for anything it can't use", () => {
    const o = oversightOf(`[oversight]
enabled = "yes"
level = "boss"
max_checkins_per_day = -3
max_checkins_per_hour = 0
summaries = { morning = "9am" }
wake = { waiting_minutes = 2.5 }
`);
    expect(o.enabled).toBe(false);
    expect(o.level).toBe("watch");
    expect(o.maxCheckinsPerDay).toBe(100);
    expect(o.maxCheckinsPerHour).toBe(6);
    expect(o.summaries.morning).toBe("09:00");
    expect(o.wake.waitingMinutes).toBe(5);
  });

  it("writes [oversight] and keeps everything else in the file", () => {
    const toml = withOversight(
      `${CONFIG}\n[oversight]\nfuture_key = "kept"\nwake = { coalesce_seconds = 60 }\n`,
      { ...DEFAULT_OVERSIGHT, enabled: true, level: "suggest", summaries: { morning: "09:00", evening: "18:00" } },
    );
    const doc = parse(toml) as Record<string, Record<string, unknown>>;
    expect(doc.llm).toEqual({ provider: "claude-code", default_model: "claude-sonnet-5-5" });
    expect(doc.rich).toEqual({ charts: true });
    expect(doc.oversight).toEqual({
      future_key: "kept",
      enabled: true,
      level: "suggest",
      track: { crew: true, desk_sessions: true, external_sessions: true, workspaces: false },
      wake: { coalesce_seconds: 60, waiting_minutes: 5, quiet_minutes: 30, on_finish: true, on_failure: true, on_message: true, hold_minutes: 2 },
      summaries: { morning: "09:00", evening: "18:00" },
      max_checkins_per_hour: 6,
      max_checkins_per_day: 100,
      act: {
        nudge: true,
        resume_restart: true,
        read_only_approvals: false,
        hand_out_work: false,
        interrupt: false,
        message_agents: false,
        message_terminal_sessions: false,
        answer_sessions: true,
      },
      work: { prefer_sessions: true, parallel: 4, take_on: "handed", engine: "claude", max_turns_per_hour: 60 },
    });
    expect(oversightOf(toml)).toEqual({ ...DEFAULT_OVERSIGHT, enabled: true, level: "suggest", summaries: { morning: "09:00", evening: "18:00" } });
  });

  it("reads the group it oversees, and writes one only while it has one, so a boss taken off leaves no group named", () => {
    const boss = oversightOf(`[oversight]\nenabled = true\ngroup = "g-acme"\n`);
    expect(boss).toMatchObject({ enabled: true, group: "g-acme" });
    expect(oversightOf(`[oversight]\ngroup = ""\n`).group).toBeNull();
    expect(oversightOf(`[oversight]\ngroup = 3\n`).group).toBeNull();
    // Another change keeps the group.
    const kept = parse(withOversight(`[oversight]\nenabled = true\ngroup = "g-acme"\n`, { ...boss, level: "act" })) as { oversight: Record<string, unknown> };
    expect(kept.oversight).toMatchObject({ enabled: true, group: "g-acme", level: "act" });
    // Stopping writes it off and names no group.
    const off = parse(withOversight(`[oversight]\nenabled = true\ngroup = "g-acme"\n`, { ...boss, enabled: false, group: null })) as {
      oversight: Record<string, unknown>;
    };
    expect(off.oversight.enabled).toBe(false);
    expect("group" in off.oversight).toBe(false);
    // The main overseer's config never gains one.
    const main = parse(withOversight(CONFIG, { ...DEFAULT_OVERSIGHT, enabled: true })) as { oversight: Record<string, unknown> };
    expect("group" in main.oversight).toBe(false);
  });

  it("reads how it runs sessions, inline or as its own table, and writes it under [oversight.work] as the hub reads it", () => {
    expect(DEFAULT_OVERSIGHT.work).toEqual({ preferSessions: true, parallel: 4, takeOn: "handed", engine: "claude", maxTurnsPerHour: 60 });
    const inline = oversightOf(`[oversight]
work = { prefer_sessions = false, parallel = 12, take_on = "all", engine = "codex", max_turns_per_hour = 1 }
`);
    const own = oversightOf(`[oversight]
[oversight.work]
prefer_sessions = false
parallel = 12
take_on = "all"
engine = "codex"
max_turns_per_hour = 1
`);
    expect(inline.work).toEqual({ preferSessions: false, parallel: 12, takeOn: "all", engine: "codex", maxTurnsPerHour: 1 });
    expect(own).toEqual(inline);
    const toml = withOversight(`${CONFIG}\n[oversight]\nenabled = true\n[oversight.work]\nfuture = 1\n`, {
      ...DEFAULT_OVERSIGHT,
      enabled: true,
      work: { preferSessions: false, parallel: 6, takeOn: "all", engine: "codex", maxTurnsPerHour: 90 },
    });
    expect(toml).toContain("[oversight.work]");
    expect((parse(toml) as { oversight: { work: unknown } }).oversight.work).toEqual({
      future: 1,
      prefer_sessions: false,
      parallel: 6,
      take_on: "all",
      engine: "codex",
      max_turns_per_hour: 90,
    });
  });

  it("reads what the hub would refuse in [oversight.work] as the defaults, and never writes it", () => {
    const o = oversightOf(`[oversight]
work = { prefer_sessions = "yes", parallel = 13, take_on = "some", engine = "Claude Code", max_turns_per_hour = 601 }
`);
    expect(o.work).toEqual(DEFAULT_OVERSIGHT.work);
    expect(oversightOf(`[oversight]\nwork = { parallel = 0, max_turns_per_hour = 0, engine = 3 }\n`).work).toEqual(DEFAULT_OVERSIGHT.work);
    expect(oversightOf(`[oversight]\nwork = { parallel = 2.5 }\n`).work.parallel).toBe(4);
    // Out of range in Desk's own state (it can't be typed, but still):
    // what is written stays inside what the hub takes.
    const doc = parse(withOversight(CONFIG, { ...DEFAULT_OVERSIGHT, work: { ...DEFAULT_OVERSIGHT.work, parallel: 40, maxTurnsPerHour: 0, engine: "Claude Code" } })) as {
      oversight: { work: Record<string, unknown> };
    };
    expect(doc.oversight.work).toMatchObject({ parallel: 12, max_turns_per_hour: 1, engine: "claude" });
  });

  it("takes 1 to 12 sessions at once as typed, and says so in the hub's words otherwise", () => {
    expect(parseParallel(" 4 ")).toEqual({ value: 4 });
    expect(parseParallel("12")).toEqual({ value: 12 });
    for (const bad of ["0", "13", "2.5", "four", ""])
      expect(parseParallel(bad)).toEqual({ problem: "How many sessions it may run at once must be a whole number from 1 to 12." });
  });

  it("writes minutes of 0 for off, as the hub takes them, and reads them back as 0", () => {
    const off = { ...DEFAULT_OVERSIGHT, enabled: true, wake: { ...DEFAULT_OVERSIGHT.wake, waitingMinutes: 0, quietMinutes: 0 } };
    const toml = withOversight(CONFIG, off);
    expect((parse(toml) as { oversight: { wake: unknown } }).oversight.wake).toMatchObject({ waiting_minutes: 0, quiet_minutes: 0 });
    expect(oversightOf(toml).wake).toMatchObject({ waitingMinutes: 0, quietMinutes: 0 });
  });

  it("keeps messaging agents and other terminals' sessions off until switched on, and writes them as the hub reads them", () => {
    expect(DEFAULT_OVERSIGHT.act).toMatchObject({ messageAgents: false, messageTerminalSessions: false });
    const read = oversightOf(`[oversight]
level = "act"
[oversight.act]
message_agents = true
message_terminal_sessions = "yes"
`);
    expect(read.act).toMatchObject({ messageAgents: true, messageTerminalSessions: false });
    for (const act of [
      { messageAgents: true, messageTerminalSessions: false },
      { messageAgents: false, messageTerminalSessions: true },
      { messageAgents: true, messageTerminalSessions: true },
    ]) {
      const o = { ...DEFAULT_OVERSIGHT, enabled: true, level: "act" as const, act: { ...DEFAULT_OVERSIGHT.act, ...act } };
      const toml = withOversight(CONFIG, o);
      expect((parse(toml) as { oversight: { act: unknown } }).oversight.act).toMatchObject({
        message_agents: act.messageAgents,
        message_terminal_sessions: act.messageTerminalSessions,
      });
      expect(oversightOf(toml)).toEqual(o);
    }
  });

  it("won't take a file it can't read", () => {
    expect(readable(CONFIG)).toBe(true);
    expect(readable("[llm\nprovider =")).toBe(false);
    expect(oversightOf("[llm\nprovider =")).toEqual(DEFAULT_OVERSIGHT);
  });
});

describe("checking what's typed, in plain words", () => {
  it("takes whole minutes up to a day", () => {
    expect(parseMinutes("5")).toEqual({ value: 5 });
    expect(parseMinutes(" 30 ")).toEqual({ value: 30 });
    expect(parseMinutes("0")).toEqual({ problem: "Use 1 to 1440 minutes (a day)." });
    expect(parseMinutes("2000")).toEqual({ problem: "Use 1 to 1440 minutes (a day)." });
    expect(parseMinutes("2.5")).toEqual({ problem: "Use a whole number of minutes." });
    expect(parseMinutes("")).toEqual({ problem: "Use a whole number of minutes." });
  });

  it("takes times of day, and writes them with two digits", () => {
    expect(parseTime("09:00")).toEqual({ value: "09:00" });
    expect(parseTime("9:00")).toEqual({ value: "09:00" });
    expect(parseTime("18.30")).toEqual({ value: "18:30" });
    expect(parseTime("24:00")).toEqual({ problem: "Use a time like 09:00 or 18:30." });
    expect(parseTime("6pm")).toEqual({ problem: "Use a time like 09:00 or 18:30." });
  });

  it("takes a daily check-in cap", () => {
    expect(parseCheckins("40")).toEqual({ value: 40 });
    expect(parseCheckins("0")).toEqual({ problem: "Use a whole number from 1 to 500." });
    expect(parseCheckins("lots")).toEqual({ problem: "Use a whole number from 1 to 500." });
    expect(parseCheckins("61", 60)).toEqual({ problem: "Use a whole number from 1 to 60." });
    expect(parseCheckins("6", 60)).toEqual({ value: 6 });
  });
});
