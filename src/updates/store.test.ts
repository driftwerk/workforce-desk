import { describe, expect, it } from "vitest";
import type { Session } from "../hub/types";
import { isWorking, readyToResume } from "./store";

const session = (id: string, state: Session["state"], live: boolean): Session =>
  ({ id, name: id, state, live, goal: "", cwd: "/", lastPrompt: null }) as Session;

describe("updates", () => {
  it("waits only for sessions that are mid-task", () => {
    expect(isWorking(session("a", "working", true))).toBe(true);
    expect(isWorking(session("b", "blocked", true))).toBe(true);
    expect(isWorking(session("c", "idle", true))).toBe(false);
    expect(isWorking(session("d", "working", false))).toBe(false);
  });

  it("resumes saved sessions once the updated hub has stopped them", () => {
    const pending = new Set(["a", "b"]);
    const sessions = [session("a", "working", true), session("b", "interrupted", false), session("c", "stopped", false)];
    expect(readyToResume(pending, sessions)).toEqual(["b"]);
  });
});

describe("what holds a restart, and which version catches up", () => {
  it("counts a session whose turn ended but background work still runs as working", async () => {
    const { isWorking } = await import("./store");
    const s = { live: true, state: "idle", background: { count: 2, since: "2026-11-12T10:00:00Z" } } as unknown as Parameters<typeof isWorking>[0];
    expect(isWorking(s)).toBe(true);
    expect(isWorking({ ...s, background: null })).toBe(false);
    expect(isWorking({ ...s, background: { count: 0, since: "" } })).toBe(false);
  });

  it("orders versions by their numbered parts", async () => {
    const { olderThan } = await import("./store");
    expect(olderThan("0.2.9", "0.2.10")).toBe(true);
    expect(olderThan("0.2.10", "0.2.9")).toBe(false);
    expect(olderThan("0.3.0", "0.3.0")).toBe(false);
    expect(olderThan("0.3", "0.3.1")).toBe(true);
  });

  it("orders pre-releases as semver does", async () => {
    const { olderThan } = await import("./store");
    const before = (a: string, b: string) => {
      expect(olderThan(a, b), `${a} < ${b}`).toBe(true);
      expect(olderThan(b, a), `${b} !< ${a}`).toBe(false);
    };
    before("1.2.3-rc.2", "1.2.3-rc.10");
    before("1.2.3-rc.1", "1.2.3");
    before("1.2.3-1", "1.2.3-alpha");
    before("1.2.3-alpha", "1.2.3-alpha.1");
    before("1.2.3-alpha.1", "1.2.3-alpha.beta");
    before("1.2.3-alpha", "1.2.3-beta");
    before("1.2.3-rc.1", "1.2.4-alpha");
    expect(olderThan("1.2.3-rc.1", "1.2.3-rc.1")).toBe(false);
    // Build metadata is no part of the order.
    expect(olderThan("1.2.3+a", "1.2.3+b")).toBe(false);
    expect(olderThan("v1.2.3", "1.2.4")).toBe(true);
    expect(olderThan("1.2.3", "v1.2.3")).toBe(false);
    expect(olderThan("1.2.3-rc.1+a", "1.2.3-rc.1+b")).toBe(false);
  });
});
