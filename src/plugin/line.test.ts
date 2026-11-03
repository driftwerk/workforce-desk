import { describe, expect, it, vi } from "vitest";
import {
  lineOf,
  PREFIX,
  register,
  type CallResult,
  type CheckResult,
  type Engine,
  type HttpResponse,
  type On,
  type Submitted,
  type ToolEvent,
  type Variable,
} from "../../src-tauri/resources/claude-plugin/hooks/line";

const HOOK = "http://127.0.0.1:9/hook/s1/tok";
const LINE = "http://127.0.0.1:9/line/s1/tok";

const TOOLS = [
  { name: "ask", description: "Ask Desk.", inputSchema: { type: "object" } },
  { name: "tell", description: "Tell Desk.", inputSchema: { type: "object" } },
];

const ok = (body: unknown, status = 200): HttpResponse => ({ status, ok: status < 400, text: body === undefined ? "" : JSON.stringify(body) });

type Hooks = {
  start?: (e: unknown) => Promise<unknown>;
  check?: (e: ToolEvent) => Promise<CheckResult>;
  call?: (e: ToolEvent) => Promise<CallResult>;
};

/** Loads the module with `env` as the session's environment and `fetch`
 *  as the host's, and starts the session. */
const load = async (fetch: (url: string, init?: { method: string; body?: string }) => Promise<HttpResponse>, env: Partial<Record<Variable, string>> = { DESK_USAGE_URL: HOOK }) => {
  const ticks: (() => unknown)[] = [];
  const submitted: string[] = [];
  let answer: Submitted | Error = { text: "" };
  const $: Engine = {
    env: { get: vi.fn((name: Variable) => Promise.resolve(env[name])) },
    http: { fetch: vi.fn(fetch) },
    tool: { register: vi.fn(() => Promise.resolve({})) },
    prompt: {
      submit: vi.fn(({ text }: { text: string }) => {
        submitted.push(text);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      }),
    },
    clock: { every: vi.fn((_ms: number, fn: () => unknown) => void ticks.push(fn)) },
  };
  const h: Hooks = {};
  const on = ((event: string, hook: (...a: unknown[]) => Promise<unknown>) => {
    const bound = (e: unknown) => hook($, e, (x: unknown) => Promise.resolve({ passed: x }));
    if (event === "session.start") h.start = bound;
    if (event === "tool.check") h.check = bound as Hooks["check"];
    if (event === "tool.call") h.call = bound as Hooks["call"];
  }) as unknown as On;
  register(on);
  await h.start!({});
  return { $, h, ticks, submitted, answerWith: (a: Submitted | Error) => (answer = a) };
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Desk's line in a Claude Code session", () => {
  it("is the session's hook address under /line/, a terminal's too", () => {
    expect(lineOf(HOOK)).toBe(LINE);
    expect(lineOf("http://127.0.0.1:9/hook/terminal/t1/k")).toBe("http://127.0.0.1:9/line/terminal/t1/k");
  });

  it("registers the hub's tools, never deferred, and polls", async () => {
    const { $, ticks } = await load(async (url) => (url === `${LINE}/tools` ? ok({ tools: TOOLS }) : ok(undefined, 204)));
    expect($.tool.register).toHaveBeenCalledTimes(2);
    expect($.tool.register).toHaveBeenCalledWith({ name: "ask", description: "Ask Desk.", inputSchema: { type: "object" }, isDeferred: false });
    expect(ticks).toHaveLength(1);
  });

  it("allows exactly its own tools and leaves every other check to Claude Code", async () => {
    const { h } = await load(async (url) => (url === `${LINE}/tools` ? ok({ tools: TOOLS }) : ok(undefined, 204)));
    expect(await h.check!({ tool: `${PREFIX}ask` })).toEqual({ decision: "allow", reason: "Desk's line" });
    expect(await h.check!({ tool: `${PREFIX}deploy` })).toEqual({ passed: { tool: `${PREFIX}deploy` } });
    expect(await h.check!({ tool: "mcp__desk_other__ask" })).toEqual({ passed: { tool: "mcp__desk_other__ask" } });
    expect(await h.check!({ tool: "Bash" })).toEqual({ passed: { tool: "Bash" } });
  });

  it("carries a call to the hub, asks again while an answer is waited for, and returns it", async () => {
    const posted: { url: string; body: unknown }[] = [];
    const { h } = await load(async (url, init) => {
      if (url === `${LINE}/tools`) return ok({ tools: TOOLS });
      if (url === `${LINE}/call`) {
        posted.push({ url, body: JSON.parse(init!.body!) });
        return ok({ result: { pending: "No answer yet", id: "q1", more: true } });
      }
      if (url === `${LINE}/await/q1?wait=25`) return ok({ result: { answer: "5433", from: "Sarah" } });
      return ok(undefined, 204);
    });
    const r = await h.call!({ tool: `${PREFIX}ask`, tool_use_id: "tu1", to: "desk", text: "Which port?" });
    expect(posted).toEqual([{ url: `${LINE}/call`, body: { name: "ask", input: { to: "desk", text: "Which port?" } } }]);
    expect(r).toEqual({ result: { answer: "5433", from: "Sarah" } });
  });

  it("gives the session the hub's refusal, or says Desk can't be reached", async () => {
    let up = true;
    const { h } = await load(async (url) => {
      if (url === `${LINE}/tools`) return ok({ tools: TOOLS });
      if (!up) throw new Error("refused");
      return ok({ error: "Loop guard: wait for the person." });
    });
    expect(await h.call!({ tool: `${PREFIX}tell`, to: "you", text: "x" })).toEqual({ deny: "Loop guard: wait for the person." });
    up = false;
    expect(await h.call!({ tool: `${PREFIX}tell`, to: "you", text: "x" })).toEqual({ deny: "Desk can't be reached right now; carry on without it." });
    expect(await h.call!({ tool: "Bash", command: "ls" })).toEqual({ passed: { tool: "Bash", command: "ls" } });
  });

  it("submits a message it is handed and acks it, or acks it dropped to have it again", async () => {
    const acks: unknown[] = [];
    let handed = true;
    const { ticks, submitted, answerWith } = await load(async (url, init) => {
      if (url === `${LINE}/tools`) return ok({ tools: TOOLS });
      if (url === `${LINE}/next?wait=20`) {
        if (!handed) return ok(undefined, 204);
        handed = false;
        return ok({ id: "m1", text: "[Desk m:0a1b2c3d] Sarah answers you: 5433" });
      }
      if (url === `${LINE}/ack`) acks.push(JSON.parse(init!.body!));
      return ok(undefined, 204);
    });
    answerWith({ text: "[Desk m:0a1b2c3d] Sarah answers you: 5433" });
    await ticks[0]!();
    await settle();
    expect(submitted).toEqual(["[Desk m:0a1b2c3d] Sarah answers you: 5433"]);
    expect(acks).toEqual([{ id: "m1", ok: true }]);
    handed = true;
    answerWith({ drop: "interrupted" });
    await ticks[0]!();
    await settle();
    expect(acks).toEqual([
      { id: "m1", ok: true },
      { id: "m1", ok: false },
    ]);
    // Nothing handed: nothing submitted.
    await ticks[0]!();
    await settle();
    expect(submitted).toHaveLength(2);
  });

  it("does nothing outside a session the hub hosts", async () => {
    const fetch = vi.fn(async () => ok({ tools: TOOLS }));
    const { $, h, ticks } = await load(fetch, {});
    expect(fetch).not.toHaveBeenCalled();
    expect($.tool.register).not.toHaveBeenCalled();
    expect(ticks).toHaveLength(0);
    expect(await h.check!({ tool: `${PREFIX}ask` })).toEqual({ passed: { tool: `${PREFIX}ask` } });
  });
});
