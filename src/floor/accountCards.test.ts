import { describe, expect, it } from "vitest";
import type { PlanReading } from "../hub/types";
import { disagree } from "./accountCards";

const H = 3_600_000;
const T = Date.parse("2026-11-16T12:00:00Z");
const iso = (ms: number) => new Date(T + ms).toISOString();

const r = (used: number, resetIn: number, readAgo: number, minutes = 10_080): PlanReading => ({
  kind: "claude",
  where: "mac",
  account: null,
  plan: "max",
  windows: [{ usedPercent: used, resetsAt: iso(resetIn), minutes }],
  observedAt: iso(-readAgo),
});

describe("readings that can't be one account's", () => {
  it("are none for an older reading below a newer one of the same week", () => {
    expect(disagree([r(75, 100 * H, 1 * H), r(12, 100 * H, 50 * H)])).toBe(false);
  });

  it("are none for a reading of last week", () => {
    expect(disagree([r(75, 100 * H, 1 * H), r(90, 100 * H - 168 * H, 200 * H)])).toBe(false);
  });

  it("are a later reading below an earlier one of the same week, beyond a point or two", () => {
    expect(disagree([r(16, 100 * H, 5 * H), r(13, 100 * H, 1 * H)])).toBe(true);
    expect(disagree([r(16, 100 * H, 5 * H), r(15, 100 * H, 1 * H)])).toBe(false);
  });

  it("are one week resetting at two times at once", () => {
    expect(disagree([r(10, 100 * H, 1 * H), r(10, 97 * H, 1 * H)])).toBe(true);
  });

  it("are never windows of different lengths", () => {
    expect(disagree([r(80, 100 * H, 1 * H), r(5, 3 * H, 0, 300)])).toBe(false);
  });
});
