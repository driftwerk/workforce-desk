// Tells the hub that hosts this session how much of the person's Claude plan
// is used, as Claude Code measures it after each turn. The hub puts where to
// post in DESK_USAGE_URL. A terminal's shell opened before the hub said so
// carries only its hooks' address, the same one, so that is used as
// desk-hook.sh finds it: DESK_HOOK_URL, or DESK_HOOK_BASE with the
// terminal's id and token. Outside a session or terminal the hub hosts, this
// does nothing.

export interface RateLimit {
  kind: string;
  percentUsed: number;
  resetsAt?: string;
}

export interface Measure {
  rateLimits: RateLimit[];
  changed: string[];
}

export type Variable = "DESK_USAGE_URL" | "DESK_HOOK_URL" | "DESK_HOOK_BASE" | "DESK_TERMINAL_ID" | "DESK_HOOK_TOKEN";

export interface Engine {
  env: { get: (name: Variable) => Promise<string | undefined> };
  http: { fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown> };
}

type Next = (e: Measure) => Promise<unknown>;

export type On = (event: "session.measure", hook: ($: Engine, e: Measure, next: Next) => Promise<unknown>) => void;

/** Where the hub hosting this session takes its hooks, if one does. */
const hubUrl = async ($: Engine): Promise<string | undefined> => {
  const usage = await $.env.get("DESK_USAGE_URL");
  if (usage) return usage;
  const hook = await $.env.get("DESK_HOOK_URL");
  if (hook) return hook;
  const [base, terminal, token] = await Promise.all([$.env.get("DESK_HOOK_BASE"), $.env.get("DESK_TERMINAL_ID"), $.env.get("DESK_HOOK_TOKEN")]);
  return base && terminal && token ? `${base}/hook/terminal/${terminal}/${token}` : undefined;
};

const report = async ($: Engine, e: Measure): Promise<void> => {
  if (!e.changed.includes("rateLimits") || e.rateLimits.length === 0) return;
  const url = await hubUrl($);
  if (!url) return;
  await $.http.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "DeskUsage", rate_limits: e.rateLimits }),
  });
};

export const register = (on: On): void => {
  on("session.measure", async ($, e, next) => {
    await report($, e).catch(() => undefined);
    return next(e);
  });
};
