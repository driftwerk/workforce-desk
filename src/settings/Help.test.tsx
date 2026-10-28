import { describe, expect, it } from "vitest";
import { helperLine } from "./Help";

describe("Help", () => {
  it("says where Desk Helper stands in plain words", () => {
    expect(helperLine({ state: "running" })).toMatch(/keeps your agents/);
    expect(helperLine({ state: "needs-approval" })).toMatch(/Login Items/);
    expect(helperLine({ state: "move-to-applications" })).toMatch(/Applications folder/);
    expect(helperLine({ state: "failed", message: "Operation not permitted" })).toBe("Operation not permitted");
    for (const s of ["running", "needs-approval", "not-registered", "move-to-applications", "development"] as const) {
      expect(helperLine({ state: s }).toLowerCase()).not.toContain("workforce");
    }
  });
});
