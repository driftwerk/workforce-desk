import { describe, expect, it } from "vitest";
import type { RoomDraft } from "../hub/store";
import { progressOf, secsLabel, STEP_LIST_AFTER_MS, stepsOf } from "./progress";

const T0 = 1_000_000;
const draft = (over: Partial<RoomDraft> = {}): RoomDraft => ({
  id: "a",
  member: "local/allan",
  threadId: null,
  asked: "q",
  since: T0,
  text: "",
  working: null,
  tools: [],
  attachments: [],
  prompts: [],
  state: "live",
  ...over,
});
const tool = (name: string, startedAt: number, endedAt?: number) => ({ name, done: endedAt !== undefined, startedAt, endedAt });

describe("an answer's progress", () => {
  it("shows chips until 20 seconds or more than three tools, then its steps", () => {
    const three = draft({ tools: [tool("a", T0, T0 + 500), tool("b", T0 + 600, T0 + 900), tool("c", T0 + 1000)] });
    expect(progressOf(three, T0 + 2000).mode).toBe("chips");
    expect(progressOf(three, T0 + STEP_LIST_AFTER_MS + 1).mode).toBe("steps");
    expect(progressOf(draft({ tools: [...three.tools, tool("d", T0 + 1100)] }), T0 + 2000).mode).toBe("steps");
  });

  it("says how long it's worked and how many steps, each with its time", () => {
    const p = progressOf(draft({ tools: [tool("repo.search", T0, T0 + 1200), tool("ci.status", T0 + 2000)] }), T0 + 250_000);
    expect(p.header).toBe("Working · 4m 10s · 2 steps");
    expect(p.steps).toEqual([
      { name: "repo.search", state: "done", secs: 1.2 },
      { name: "ci.status", state: "running", secs: 248 },
    ]);
  });

  it("says it's waiting on you while it asks, here or on the Floor", () => {
    const prompt = { requestId: "p", tool: "t", content: "", options: {} as never, turnRef: null };
    expect(progressOf(draft({ prompts: [prompt] }), T0)).toMatchObject({ waiting: true, header: "Waiting on you", mode: "steps" });
    expect(progressOf(draft(), T0, true)).toMatchObject({ waiting: true });
  });

  it("says how long it has been stalled", () => {
    expect(progressOf(draft({ state: "stalled", stalledSince: T0 + 1000 }), T0 + 41_000).header).toBe("Stalled · 40s");
  });

  it("leaves a stopped answer's running steps unfinished", () => {
    const p = progressOf(draft({ state: "stopped", tools: [tool("a", T0, T0 + 10), tool("b", T0 + 20)] }), T0 + 5000);
    expect(p.steps.map((s) => s.state)).toEqual(["done", "unfinished"]);
    expect(p.waiting).toBe(false);
  });

  it("reads a posted answer's steps", () => {
    expect(stepsOf([{ tool: "ci.status", ok: false, ms: 1500 }])).toEqual([{ name: "ci.status", state: "failed", secs: 1.5 }]);
    expect(secsLabel(1.5)).toBe("1.5s");
    expect(secsLabel(250)).toBe("4m 10s");
    expect(secsLabel(null)).toBe("");
  });
});
