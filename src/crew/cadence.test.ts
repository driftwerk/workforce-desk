import { describe, expect, it } from "vitest";
import { BALANCED, cadenceOf, presetOf, problemOf, readCadence, summaryOf, withCadence, withPreset } from "./cadence";

describe("the boss's cadence in its config", () => {
  it("is Balanced unsaid, and reads what is written", () => {
    expect(cadenceOf("")).toEqual(BALANCED);
    expect(presetOf(BALANCED)).toBe("balanced");
    const c = cadenceOf('[oversight]\nenabled = true\nupdates = { roundup = "2h", quiet_hours = "", progress = "ask" }\n');
    expect(c.roundup).toBe("2h");
    expect(c.quiet).toBeNull();
    expect(c.progress).toBe("ask");
    expect(presetOf(c)).toBeNull();
  });

  it("writes only the cadence keys, keeping the rest", () => {
    const source = '[llm]\nprovider = "claude-code"\n\n[oversight]\nenabled = true\nlevel = "act"\n\n[oversight.updates]\nevery_minutes = 5\n';
    const out = withCadence(source, withPreset(BALANCED, "roundups_only"));
    const back = cadenceOf(out);
    expect(presetOf(back)).toBe("roundups_only");
    expect(out).toContain('provider = "claude-code"');
    expect(out).toContain('level = "act"');
    expect(out).toContain("every_minutes = 5");
    expect(out).toContain('quiet_hours = "22:00-07:00"');
  });

  it("refuses news held for a roundup that never comes, as the hub does", () => {
    expect(problemOf({ ...BALANCED, roundup: "never" })).toMatch(/finished work and progress would never be told/);
    expect(problemOf(withPreset(BALANCED, "as_it_happens"))).toBeNull();
  });

  it("says itself in the card's words", () => {
    const lines = summaryOf(BALANCED).map((l) => `${l.label} ${l.text}`.trim());
    expect(lines).toEqual([
      "Right away: anything that needs you and problems",
      "Every hour: finished work and progress",
      "Decided without you: the important ones, in the roundup",
      "Only if you ask: routine nudges and checks",
      "Quiet 22:00–07:00: held for the morning, except what needs you",
    ]);
  });

  it("reads it as the hub does: trimmed, an hour of one digit, kept on the next write", () => {
    const source = '[oversight]\nenabled = true\n\n[oversight.updates]\nquiet_hours = "22:00-7:00"\nfinished = " right_away "\nalso_to = ["desk", "slack"]\n';
    const c = cadenceOf(source);
    expect(c.quiet).toEqual({ from: "22:00", until: "07:00" });
    expect(c.finished).toBe("right_away");
    const out = withCadence(source, { ...c, decisions: "all" });
    expect(out).toContain('quiet_hours = "22:00-07:00"');
    expect(out).toMatch(/also_to = \[ "desk", "slack" \]/);
  });

  it("says what the hub would refuse, with Balanced as the base to write afresh", () => {
    const bad = readCadence('[oversight.updates]\nroundup = "5m"\nfinished = "right_away"\n');
    expect(bad.problem).toMatch(/How often the roundup comes must be/);
    expect(bad.cadence).toEqual(BALANCED);
    expect(readCadence('[oversight.updates]\nquiet_hours = "22-7"\n').problem).toMatch(/quiet hours must look like/);
    expect(readCadence('[oversight.updates]\nneeds_you = "ask"\n').problem).toMatch(/right away or in the roundup/);
    expect(readCadence('[oversight.updates]\nroundup = "never"\n').problem).toMatch(/finished work and progress would never be told/);
    expect(readCadence("").problem).toBeNull();
  });
});
