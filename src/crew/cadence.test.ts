import { describe, expect, it } from "vitest";
import {
  BALANCED,
  cadenceOf,
  presetOf,
  problemOf,
  summaryOf,
  withCadence,
  withPreset,
} from "./cadence";

describe("the boss's cadence in its config", () => {
  it("is Balanced unsaid, and reads what is written", () => {
    expect(cadenceOf("")).toEqual(BALANCED);
    expect(presetOf(BALANCED)).toBe("balanced");
    const c = cadenceOf(
      '[oversight]\nenabled = true\nupdates = { roundup = "2h", quiet_hours = "", progress = "ask", needs_you = "ask" }\n',
    );
    expect(c.roundup).toBe("2h");
    expect(c.quiet).toBeNull();
    expect(c.progress).toBe("ask");
    expect(c.needs_you).toBe("right_away");
    expect(presetOf(c)).toBeNull();
  });

  it("writes only the cadence keys, keeping the rest", () => {
    const source =
      '[llm]\nprovider = "claude-code"\n\n[oversight]\nenabled = true\nlevel = "act"\n\n[oversight.updates]\nevery_minutes = 5\n';
    const out = withCadence(source, withPreset(BALANCED, "roundups_only"));
    const back = cadenceOf(out);
    expect(presetOf(back)).toBe("roundups_only");
    expect(out).toContain('provider = "claude-code"');
    expect(out).toContain('level = "act"');
    expect(out).toContain("every_minutes = 5");
    expect(out).toContain('quiet_hours = "22:00-07:00"');
  });

  it("refuses news held for a roundup that never comes, as the hub does", () => {
    expect(problemOf({ ...BALANCED, roundup: "never" })).toMatch(
      /finished and progress would never be told/,
    );
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
});
