import { describe, expect, it } from "vitest";
import { after, byTime, instant, justBefore, later } from "./time";

describe("instant", () => {
  it("reads 0, 3, 6 and 9 fractional digits as the same clock", () => {
    const base = instant("2026-10-27T09:14:30Z");
    expect(instant("2026-10-27T09:14:30.500Z") - base).toBe(500_000n);
    expect(instant("2026-10-27T09:14:30.000500Z") - base).toBe(500n);
    expect(instant("2026-10-27T09:14:30.000000501Z") - base).toBe(0n);
    expect(instant("2026-10-27T10:14:30+01:00")).toBe(base);
  });

  it("orders what string comparison gets wrong", () => {
    expect("2026-10-27T09:14:30Z" > "2026-10-27T09:14:30.5Z").toBe(true);
    expect(after({ createdAt: "2026-10-27T09:14:30.5Z" }, "2026-10-27T09:14:30Z")).toBe(true);
    expect(later("2026-10-27T09:14:30Z", "2026-10-27T09:14:30.5Z")).toBe("2026-10-27T09:14:30.5Z");
  });
});

describe("byTime", () => {
  it("breaks a tie at one instant by id", () => {
    const at = "2026-10-27T09:14:30.123456Z";
    const ms = [
      { id: "c", createdAt: at },
      { id: "a", createdAt: "2026-10-27T09:14:30.123456000Z" },
      { id: "b", createdAt: "2026-10-27T09:14:30Z" },
    ];
    expect([...ms].sort(byTime).map((m) => m.id)).toEqual(["b", "a", "c"]);
  });
});

describe("justBefore", () => {
  it("is one microsecond earlier", () => {
    const at = "2026-10-27T09:14:30.5Z";
    expect(instant(at) - instant(justBefore(at))).toBe(1n);
  });
});
