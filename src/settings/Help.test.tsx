import { describe, expect, it } from "vitest";
import { helperLine } from "./Help";

describe("Help", () => {
  it("says where Desk Helper stands in plain words", () => {
    expect(helperLine({ state: "running" }, "macos")).toMatch(/keeps your agents/);
    expect(helperLine({ state: "move-to-applications" }, "macos")).toMatch(/Applications folder/);
    expect(helperLine({ state: "failed", message: "Operation not permitted" }, "linux")).toBe("Operation not permitted");
    for (const s of ["running", "needs-approval", "not-registered", "move-to-applications", "development"] as const) {
      expect(helperLine({ state: s }, "macos").toLowerCase()).not.toContain("workforce");
    }
  });

  it("names where each system turns Desk Helper off", () => {
    expect(helperLine({ state: "needs-approval" }, "macos")).toMatch(/Login Items/);
    expect(helperLine({ state: "needs-approval" }, "windows")).toMatch(/Startup apps/);
    expect(helperLine({ state: "needs-approval" }, "linux")).toMatch(/autostart/);
  });
});
