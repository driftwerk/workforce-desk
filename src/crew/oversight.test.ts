import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { DEFAULT_OVERSIGHT, oversightOf, parseCheckins, parseMinutes, parseTime, readable, withOversight } from "./oversight";

const CONFIG = `[llm]
provider = "claude-code"
default_model = "claude-sonnet-5-5"

[rich]
charts = true
`;

describe("[oversight] in an agent's config", () => {
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
wake = { waiting_minutes = 10, quiet_minutes = 0, on_finish = false, on_failure = true }
summaries = { morning = "08:30", evening = "" }
max_checkins_per_day = 12
act = { nudge = false, resume_restart = true, read_only_approvals = true, hand_out_work = false }
`);
    expect(o).toEqual({
      enabled: true,
      level: "act",
      track: { crew: true, deskSessions: false, externalSessions: true, workspaces: true },
      wake: { waitingMinutes: 10, quietMinutes: 0, onFinish: false, onFailure: true },
      summaries: { morning: "08:30", evening: "" },
      maxCheckinsPerDay: 12,
      act: { nudge: false, resumeRestart: true, readOnlyApprovals: true, handOutWork: false },
    });
  });

  it("uses the default for anything it can't use", () => {
    const o = oversightOf(`[oversight]
enabled = "yes"
level = "boss"
max_checkins_per_day = -3
summaries = { morning = "9am" }
wake = { waiting_minutes = 2.5 }
`);
    expect(o.enabled).toBe(false);
    expect(o.level).toBe("watch");
    expect(o.maxCheckinsPerDay).toBe(40);
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
      wake: { coalesce_seconds: 60, waiting_minutes: 5, quiet_minutes: 30, on_finish: true, on_failure: true },
      summaries: { morning: "09:00", evening: "18:00" },
      max_checkins_per_day: 40,
      act: { nudge: true, resume_restart: true, read_only_approvals: false, hand_out_work: false },
    });
    expect(oversightOf(toml)).toEqual({ ...DEFAULT_OVERSIGHT, enabled: true, level: "suggest", summaries: { morning: "09:00", evening: "18:00" } });
  });

  it("writes minutes of 0 for off, as the hub takes them, and reads them back as 0", () => {
    const off = { ...DEFAULT_OVERSIGHT, enabled: true, wake: { ...DEFAULT_OVERSIGHT.wake, waitingMinutes: 0, quietMinutes: 0 } };
    const toml = withOversight(CONFIG, off);
    expect((parse(toml) as { oversight: { wake: unknown } }).oversight.wake).toMatchObject({ waiting_minutes: 0, quiet_minutes: 0 });
    expect(oversightOf(toml).wake).toMatchObject({ waitingMinutes: 0, quietMinutes: 0 });
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
  });
});
