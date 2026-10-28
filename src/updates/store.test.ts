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
