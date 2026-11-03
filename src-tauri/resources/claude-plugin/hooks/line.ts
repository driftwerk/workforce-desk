// Desk's line in a Claude Code session the hub hosts: the tools the session
// asks Desk, the person and other sessions with (ask, tell, reply, inbox,
// peers), and the messages sent to it, submitted once it is idle. The hub
// defines the tools (GET <line>/tools) and runs every call (POST
// <line>/call); this module only carries them. Messages come from a long
// poll (GET <line>/next), each submitted as a prompt of its own and acked
// once Claude Code took it, or as dropped (the person interrupted), which
// sends it again. Outside a session or terminal the hub hosts, it does
// nothing.

export type Variable = "DESK_USAGE_URL" | "DESK_HOOK_URL" | "DESK_HOOK_BASE" | "DESK_TERMINAL_ID" | "DESK_HOOK_TOKEN";

export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  isDeferred?: boolean;
}

export type Submitted = { text: string } | { drop: string };

export interface Engine {
  env: { get: (name: Variable) => Promise<string | undefined> };
  http: { fetch: (url: string, init?: { method: string; headers?: Record<string, string>; body?: string }) => Promise<HttpResponse> };
  tool: { register: (tool: ToolSpec) => Promise<unknown> };
  prompt: { submit: (input: { text: string }) => Promise<Submitted> };
  clock: { every: (ms: number, fn: () => unknown) => unknown };
}

export interface ToolEvent {
  tool: string;
  [arg: string]: unknown;
}

export type CheckResult = { decision: "allow" | "ask" | "deny"; reason?: string };
export type CallResult = { result: unknown } | { deny: string };

type Next<E, R> = (e: E) => Promise<R>;

export interface On {
  (event: "session.start", hook: ($: Engine, e: unknown, next: Next<unknown, unknown>) => Promise<unknown>): void;
  (event: "tool.check", hook: ($: Engine, e: ToolEvent & { input?: unknown }, next: Next<ToolEvent, CheckResult>) => Promise<CheckResult>): void;
  (event: "tool.call", hook: ($: Engine, e: ToolEvent, next: Next<ToolEvent, CallResult>) => Promise<CallResult>): void;
}

/** What Claude Code names the plugin's tools: `mcp__<plugin>__<name>`. */
export const PREFIX = "mcp__desk__";

/** How often the module looks for a message when none is on its way. */
export const POLL_MS = 3000;

/** The keys a tool call carries beside the tool's own arguments. */
const RESERVED = new Set(["tool", "tool_use_id", "agentId", "requestMeta", "consent"]);

/** Where the hub hosting this session takes its hooks, if one does (as
 *  usage.ts finds it). */
const hookUrl = async ($: Engine): Promise<string | undefined> => {
  const usage = await $.env.get("DESK_USAGE_URL");
  if (usage) return usage;
  const hook = await $.env.get("DESK_HOOK_URL");
  if (hook) return hook;
  const [base, terminal, token] = await Promise.all([$.env.get("DESK_HOOK_BASE"), $.env.get("DESK_TERMINAL_ID"), $.env.get("DESK_HOOK_TOKEN")]);
  return base && terminal && token ? `${base}/hook/terminal/${terminal}/${token}` : undefined;
};

/** The session's line on the hub: its hook address, under `/line/`. */
export const lineOf = (hook: string): string => hook.replace("/hook/", "/line/");

const json = (r: HttpResponse): unknown => {
  try {
    return JSON.parse(r.text);
  } catch {
    return undefined;
  }
};

const UNREACHABLE = "Desk can't be reached right now; carry on without it.";

/** What the module knows of the session it runs in. */
interface Line {
  /** The session's line on the hub, once it is known. */
  url?: string;
  /** Desk's tools, by the names Claude Code calls them. */
  names: Set<string>;
  /** A poll is under way. */
  polling: boolean;
}

const post = ($: Engine, line: Line, path: string, body: unknown): Promise<HttpResponse> =>
  $.http.fetch(`${line.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** One message for the session, if one comes: submitted, then acked. */
const poll = async ($: Engine, line: Line): Promise<void> => {
  if (!line.url || line.polling) return;
  line.polling = true;
  try {
    const r = await $.http.fetch(`${line.url}/next?wait=20`);
    if (r.status !== 200) return;
    const next = json(r) as { id?: string; text?: string } | undefined;
    if (!next?.id || !next.text) return;
    const id = next.id;
    // Not awaited here: it resolves once the prompt is in (or queued
    // behind the turn running), and the poll goes on meanwhile.
    void $.prompt
      .submit({ text: next.text })
      .then((done) => post($, line, "/ack", { id, ok: !("drop" in done) }))
      .catch(() => post($, line, "/ack", { id, ok: false }).catch(() => undefined));
  } catch {
    // The hub restarted or is gone: the next tick asks again.
  } finally {
    line.polling = false;
  }
};

/** Registers the hub's line tools and starts polling for messages. */
const start = async ($: Engine, line: Line): Promise<void> => {
  const hook = await hookUrl($).catch(() => undefined);
  if (!hook) return;
  line.url = lineOf(hook);
  try {
    const listed = json(await $.http.fetch(`${line.url}/tools`)) as { tools?: ToolSpec[] } | undefined;
    for (const t of listed?.tools ?? []) {
      // Seen on every turn: Desk's tools are never behind a search.
      await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: false });
      line.names.add(`${PREFIX}${t.name}`);
    }
    $.clock.every(POLL_MS, () => poll($, line));
  } catch {
    line.url = undefined;
  }
};

/** Runs one of Desk's tools on the hub; a long wait for an answer is asked
 *  again, a request at a time. */
const call = async ($: Engine, line: Line, e: ToolEvent): Promise<CallResult> => {
  const input = Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k)));
  try {
    let answer = json(await post($, line, "/call", { name: e.tool.slice(PREFIX.length), input })) as { result?: Record<string, unknown>; error?: string } | undefined;
    while (answer?.result?.more === true && typeof answer.result.id === "string") {
      answer = json(await $.http.fetch(`${line.url}/await/${answer.result.id}?wait=25`)) as typeof answer;
    }
    if (answer?.error) return { deny: answer.error };
    if (!answer || !("result" in answer)) return { deny: UNREACHABLE };
    return { result: answer.result };
  } catch {
    return { deny: UNREACHABLE };
  }
};

export const register = (on: On): void => {
  const line: Line = { names: new Set(), polling: false };

  on("session.start", async ($, e, next) => {
    await start($, line);
    return next(e);
  });

  // Desk's own tools run without the session's permission dialog: exactly
  // those, never another server's tool that shares the prefix.
  on("tool.check", async (_$, e, next) => (line.names.has(e.tool) ? { decision: "allow", reason: "Desk's line" } : next(e)));

  on("tool.call", async ($, e, next) => (line.names.has(e.tool) && line.url ? call($, line, e) : next(e)));
};
