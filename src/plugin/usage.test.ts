import { describe, expect, it, vi } from "vitest";
import { register, type Engine, type Measure, type On } from "../../src-tauri/resources/claude-plugin/hooks/usage";

const LIMITS = [
  { kind: "five_hour", percentUsed: 62, resetsAt: "2026-10-29T19:10:00Z" },
  { kind: "seven_day", percentUsed: 38.5, resetsAt: "2026-11-02T09:00:00Z" },
];

/** Runs the module's `session.measure` hook once on `e`, with `url` as the
 *  environment's DESK_USAGE_URL and `fetch` as the host's. */
const measure = async (e: Measure, url: string | undefined, fetch: Engine["http"]["fetch"] = vi.fn(() => Promise.resolve({ ok: true }))) => {
  let hook: Parameters<On>[1] | undefined;
  register((event, h) => {
    expect(event).toBe("session.measure");
    hook = h;
  });
  const next = vi.fn(() => Promise.resolve({ changed: e.changed }));
  const $: Engine = { env: { get: vi.fn(() => Promise.resolve(url)) }, http: { fetch } };
  const result = await hook!($, e, next);
  return { fetch, next, result };
};

describe("the Desk plugin's usage hook", () => {
  it("posts the plan's limits to the hub when they moved", async () => {
    const { fetch, next, result } = await measure({ rateLimits: LIMITS, changed: ["context", "rateLimits"] }, "http://127.0.0.1:9/hook/s/t");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9/hook/s/t", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook_event_name: "DeskUsage", rate_limits: LIMITS }),
    });
    expect(next).toHaveBeenCalledOnce();
    expect(result).toEqual({ changed: ["context", "rateLimits"] });
  });

  it("does nothing outside a session the hub hosts, without limits, or when they didn't move", async () => {
    for (const [e, url] of [
      [{ rateLimits: LIMITS, changed: ["rateLimits"] }, undefined],
      [{ rateLimits: [], changed: ["rateLimits"] }, "http://hub"],
      [{ rateLimits: LIMITS, changed: ["context", "cost"] }, "http://hub"],
    ] as const) {
      const { fetch, next } = await measure({ rateLimits: [...e.rateLimits], changed: [...e.changed] }, url);
      expect(fetch).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it("carries on when the hub can't be reached", async () => {
    const { next, result } = await measure({ rateLimits: LIMITS, changed: ["rateLimits"] }, "http://hub", () => Promise.reject(new Error("refused")));
    expect(next).toHaveBeenCalledOnce();
    expect(result).toEqual({ changed: ["rateLimits"] });
  });
});
