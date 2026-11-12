import { describe, expect, it } from "vitest";
import { helperLine, updateLine } from "./Help";

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

  it("says whether a version ready installs by itself, or was put off", () => {
    const ready = { phase: "ready", version: "0.2.1" } as const;
    expect(updateLine(ready, true, null, null)).toContain("installs by itself once your sessions finish");
    expect(updateLine(ready, false, null, null)).toBe("Desk 0.2.1 is ready, put off for now. Check for updates to have it install by itself again.");
  });
});
