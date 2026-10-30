import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clock, dayClock, durationOf, nextLocalMidnight, since, startOfLocalDay } from "./time";

beforeAll(() => void vi.stubEnv("TZ", "Europe/London"));
afterAll(() => void vi.unstubAllEnvs());

const now = Date.parse("2026-10-29T16:42:00Z");

describe("the floor's clock words", () => {
  it("say a time against today, yesterday, tomorrow, the week and further", () => {
    expect(dayClock("2026-10-29T16:20:00Z", now)).toBe(clock("2026-10-29T16:20:00Z"));
    expect(dayClock("2026-10-28T18:40:00Z", now)).toBe(`yesterday ${clock("2026-10-28T18:40:00Z")}`);
    expect(dayClock("2026-10-30T09:00:00Z", now)).toBe(`tomorrow ${clock("2026-10-30T09:00:00Z")}`);
    expect(dayClock("2026-11-02T09:00:00Z", now)).toMatch(/^Mon /);
    expect(dayClock("2026-10-26T09:00:00Z", now)).toMatch(/^Mon /);
    expect(dayClock("2026-10-12T09:00:00Z", now)).toMatch(/12/);
    expect(dayClock("not a time", now)).toBe("");
  });

  it("say how long, never below none", () => {
    expect(durationOf("2026-10-29T15:32:00Z", "2026-10-29T16:20:00Z")).toBe("48m");
    expect(durationOf("2026-10-29T15:15:00Z", "2026-10-29T16:20:00Z")).toBe("1h 05m");
    expect(durationOf("2026-10-29T16:20:00Z", "2026-10-29T16:00:00Z")).toBe("0m");
  });

  it("find local midnights across a clock change", () => {
    const sunday = Date.parse("2026-10-25T12:00:00Z");
    expect(startOfLocalDay(sunday).toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(nextLocalMidnight(sunday).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("keep the overview's own words", () => {
    expect(since(new Date(now - 6 * 60_000).toISOString(), now)).toBe("6 min");
    expect(since(new Date(now - 72 * 60_000).toISOString(), now)).toBe("1h 12m");
  });
});
