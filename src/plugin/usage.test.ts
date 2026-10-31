import { describe, expect, it, vi } from "vitest";
import { register, type Engine, type Measure, type On, type Variable } from "../../src-tauri/resources/claude-plugin/hooks/usage";

const LIMITS = [
  { kind: "five_hour", percentUsed: 62, resetsAt: "2026-10-29T19:10:00Z" },
  { kind: "seven_day", percentUsed: 38.5, resetsAt: "2026-11-02T09:00:00Z" },
];

type Env = Partial<Record<Variable, string>>;

/** Runs the module's `session.measure` hook once on `e`, with `env` as the
 *  environment (a string: its DESK_USAGE_URL) and `fetch` as the host's. */
const measure = async (e: Measure, env: Env | string | undefined, fetch: Engine["http"]["fetch"] = vi.fn(() => Promise.resolve({ ok: true }))) => {
  const vars: Env = typeof env === "string" ? { DESK_USAGE_URL: env } : (env ?? {});
  let hook: Parameters<On>[1] | undefined;
  register((event, h) => {
    expect(event).toBe("session.measure");
    hook = h;
  });
  const next = vi.fn(() => Promise.resolve({ changed: e.changed }));
  const $: Engine = { env: { get: vi.fn((name: Variable) => Promise.resolve(vars[name])) }, http: { fetch } };
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

  it("posts to a terminal's hooks when its shell predates the usage address", async () => {
    const posted = async (env: Env) => {
      const { fetch } = await measure({ rateLimits: LIMITS, changed: ["rateLimits"] }, env);
      return (fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    };
    expect(await posted({ DESK_HOOK_URL: "http://127.0.0.1:9/hook/terminal/t/k" })).toEqual(["http://127.0.0.1:9/hook/terminal/t/k"]);
    expect(await posted({ DESK_HOOK_BASE: "http://127.0.0.1:9", DESK_TERMINAL_ID: "t", DESK_HOOK_TOKEN: "k" })).toEqual([
      "http://127.0.0.1:9/hook/terminal/t/k",
    ]);
    expect(await posted({ DESK_USAGE_URL: "http://127.0.0.1:9/hook/s/u", DESK_HOOK_URL: "http://127.0.0.1:9/hook/terminal/t/k" })).toEqual([
      "http://127.0.0.1:9/hook/s/u",
    ]);
    expect(await posted({ DESK_HOOK_BASE: "http://127.0.0.1:9", DESK_TERMINAL_ID: "t" })).toEqual([]);
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
