import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { abilitiesOf, DESK_DEFAULTS, rememberDefaults, rememberDiffers, withAbilities } from "./abilities";

const doc = (toml: string) => parse(toml) as Record<string, Record<string, unknown>>;

describe("an agent's abilities", () => {
  it("are Desk's defaults where its file says nothing, and its file adds nothing for them", () => {
    expect(abilitiesOf("")).toEqual(DESK_DEFAULTS);
    expect(abilitiesOf("not = [toml")).toEqual(DESK_DEFAULTS);
    expect(withAbilities(`[llm]\nprovider = "claude-code"\n`, DESK_DEFAULTS)).toBe(`[llm]\nprovider = "claude-code"\n`);
  });

  it("are written only where they differ from Desk's, and everything else in the file stays", () => {
    const start = `# mine\n[llm]\nprovider = "chatgpt"\n\n[memory]\nrecall_min_certainty = 0.6\n\n[advisor]\nmodel = "opus"\n`;
    const toml = withAbilities(start, {
      ...DESK_DEFAULTS,
      passive: false,
      lessons: false,
      tidyEvery: 86400,
      advisorEffort: "max",
      angles: 2,
      programs: false,
      knowHow: "on",
    });
    const d = doc(toml);
    expect(d.llm).toEqual({ provider: "chatgpt" });
    expect(d.memory).toEqual({
      recall_min_certainty: 0.6,
      passive: false,
      lesson_extract: false,
      lesson_inject: false,
      consolidation_interval_secs: 86400,
    });
    expect(d.advisor).toEqual({ model: "opus", cc_effort: "max", fanout: { max_lenses: 2, max_concurrent: 2 } });
    expect(d.tools).toEqual({ programs: { enabled: false } });
    expect(d.know_how).toEqual({ inject: "on" });
    expect(d.self_learning).toBeUndefined();
    expect(abilitiesOf(toml)).toMatchObject({ passive: false, lessons: false, tidyEvery: 86400, angles: 2, knowHow: "on" });
  });

  it("turn self-learning and claim checking off with a section of their own, which replaces the hub's whole", () => {
    const off = withAbilities("", { ...DESK_DEFAULTS, learn: false, grounding: false, knowHow: "off" });
    expect(doc(off).self_learning).toEqual({ enabled: false });
    expect(doc(off).claim_grounding).toEqual({ enabled: false });
    expect(doc(off).know_how).toEqual({ enabled: false });
    expect(abilitiesOf(off)).toMatchObject({ learn: false, grounding: false, knowHow: "off" });
    const on = withAbilities(off, DESK_DEFAULTS);
    expect(on).toBe("");
    // A section the person filled in is kept, and stays on.
    const theirs = withAbilities(`[self_learning]\nenabled = false\nmax_rounds = 10\n`, DESK_DEFAULTS);
    expect(doc(theirs).self_learning).toEqual({ enabled: true, max_rounds: 10 });
    expect(abilitiesOf(`[self_learning]\nmax_rounds = 10\n`).learn).toBe(false);
  });

  it("read lessons as on only when both halves are, and angles within what this computer runs at once", () => {
    expect(abilitiesOf(`[memory]\nlesson_inject = false\n`).lessons).toBe(false);
    expect(abilitiesOf(`[advisor.fanout]\nmax_lenses = 8\n`).angles).toBe(3);
    expect(abilitiesOf(`[advisor]\ncc_effort = "low"\n`).advisorEffort).toBe("high");
  });

  it("say when remembering differs from Desk's defaults, and go back to them", () => {
    const changed = { ...DESK_DEFAULTS, rapport: false, tidyEvery: 3600, advisor: false };
    expect(rememberDiffers(changed)).toBe(true);
    const back = rememberDefaults(changed);
    expect(rememberDiffers(back)).toBe(false);
    // Only remembering goes back.
    expect(back.advisor).toBe(false);
  });

  it("keep check-in hours as times", () => {
    const toml = withAbilities("", { ...DESK_DEFAULTS, heartbeat: true, heartbeatEvery: 1800, quietFrom: "22:00", quietTo: "07:00" });
    expect(doc(toml).heartbeat).toEqual({ enabled: true, interval_secs: 1800, quiet_start: "22:00", quiet_end: "07:00" });
    expect(abilitiesOf(`[heartbeat]\nquiet_start = "late"\n`).quietFrom).toBe("");
  });
});
