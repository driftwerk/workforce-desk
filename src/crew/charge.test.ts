import { describe, expect, it } from "vitest";
import type { ChargeView } from "../hub/types";
import { lined } from "../line/testing";
import { badgeOf, chargeChoices, chargeable, howText, wheelText, type Boss } from "./charge";

const charge = (more: Partial<ChargeView> = {}): ChargeView => ({
  session: "s1",
  group: null,
  boss: "sarah",
  bossName: "Sarah",
  how: "handed",
  wheel: "boss",
  wheelSince: null,
  since: "2026-11-03T10:00:00Z",
  releasedAt: null,
  ...more,
});

const SARAH: Boss = { id: "sarah", name: "Sarah", level: "act" };

describe("a session a boss runs", () => {
  it("is badged with whose it is, and dashed while you drive", () => {
    expect(badgeOf(charge())).toEqual({ text: "Sarah has it", look: "boss" });
    expect(badgeOf(charge(), true)).toEqual({ text: "Sarah’s", look: "boss" });
    for (const wheel of ["person", "person_pinned"] as const) {
      expect(badgeOf(charge({ wheel }))).toEqual({ text: "You’re driving", look: "you" });
      expect(badgeOf(charge({ wheel }), true)).toEqual({ text: "Yours", look: "you" });
    }
    expect(badgeOf(charge({ releasedAt: "2026-11-03T11:00:00Z" }))).toBeNull();
    expect(badgeOf(undefined)).toBeNull();
  });

  it("says who has the wheel, and when it comes back, in a sentence", () => {
    expect(wheelText(charge())).toBe("Sarah runs this session. Typing in it, prompting it or writing to it makes you the driver.");
    expect(wheelText(charge({ wheel: "person" }))).toBe("Sarah’s messages to it wait while you drive. Sarah has it back after 2 quiet minutes.");
    expect(wheelText(charge({ wheel: "person", holdMinutes: 5 }))).toBe("Sarah’s messages to it wait while you drive. Sarah has it back after 5 quiet minutes.");
    expect(wheelText(charge({ wheel: "person", holdMinutes: 1 }))).toBe("Sarah’s messages to it wait while you drive. Sarah has it back after 1 quiet minute.");
    expect(wheelText(charge({ wheel: "person_pinned" }))).toBe("Sarah’s messages to it wait until you hand it back.");
    expect(howText(charge({ how: "started" }))).toBe("Sarah started it");
    expect(howText(charge())).toBe("You handed it to Sarah");
    expect(howText(charge({ how: "taken" }))).toBe("Sarah takes on every session");
  });

  it("offers I'll drive until it's pinned, Hand back while you drive, and Release either way", () => {
    expect(chargeChoices(lined(), charge(), SARAH).map((c) => c.label)).toEqual(["I’ll drive", "Release"]);
    expect(chargeChoices(lined(), charge({ wheel: "person" }), SARAH).map((c) => c.label)).toEqual(["I’ll drive", "Hand back", "Release"]);
    expect(chargeChoices(lined(), charge({ wheel: "person_pinned" }), SARAH).map((c) => c.verb)).toEqual(["handBack", "release"]);
  });

  it("offers Hand to the boss only on a session it could run, and only when it does more than watch", () => {
    expect(chargeChoices(lined(), undefined, SARAH)).toEqual([{ verb: "hand", label: "Hand to Sarah" }]);
    expect(chargeChoices(lined(), undefined, { ...SARAH, level: "suggest" }).map((c) => c.label)).toEqual(["Hand to Sarah"]);
    expect(chargeChoices(lined(), undefined, { ...SARAH, level: "watch" })).toEqual([]);
    expect(chargeChoices(lined(), undefined, null)).toEqual([]);
    expect(chargeChoices(lined({ origin: "external" }), undefined, SARAH)).toEqual([]);
  });

  it("can't be one with no line from Desk, in the hub's words", () => {
    expect(chargeable(lined())).toEqual({ ok: true });
    expect(chargeable(lined({ origin: "external" }))).toEqual({ ok: false, why: "It runs in another terminal. Continue it in Desk first." });
    expect(chargeable(lined({ state: "closed" }))).toEqual({ ok: false, why: "It has ended." });
    expect(chargeable(lined({ engine: "custom" }))).toEqual({ ok: false, why: "A custom command has no line for a boss to talk on." });
    const old = lined({ caps: { ...lined().caps!, line: "none", notes: ["Update Claude Code to 2.1.287 or later."] } });
    expect(chargeable(old)).toEqual({ ok: false, why: "Update Claude Code to 2.1.287 or later." });
    expect(chargeable(lined({ engine: "codex", caps: { ...lined().caps!, line: "none", notes: [] } }))).toEqual({
      ok: false,
      why: "Codex sessions have no line from Desk yet.",
    });
  });
});
