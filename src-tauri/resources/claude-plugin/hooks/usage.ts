// Tells the hub that hosts this session how much of the person's Claude plan
// is used, as Claude Code measures it after each turn. The hub puts where to
// post in DESK_USAGE_URL; outside a session or terminal it hosts, this does
// nothing.

export interface RateLimit {
  kind: string;
  percentUsed: number;
  resetsAt?: string;
}

export interface Measure {
  rateLimits: RateLimit[];
  changed: string[];
}

export interface Engine {
  env: { get: (name: "DESK_USAGE_URL") => Promise<string | undefined> };
  http: { fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown> };
}

type Next = (e: Measure) => Promise<unknown>;

export type On = (event: "session.measure", hook: ($: Engine, e: Measure, next: Next) => Promise<unknown>) => void;

const report = async ($: Engine, e: Measure): Promise<void> => {
  if (!e.changed.includes("rateLimits") || e.rateLimits.length === 0) return;
  const url = await $.env.get("DESK_USAGE_URL");
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
