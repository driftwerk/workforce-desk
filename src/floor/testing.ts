import { vi } from "vitest";
import type { HubAccount } from "../chat/types";
import type { FloorView, Need, UsageView, Who, Work } from "../hub/types";
import type { HubFloor } from "./store";

export const NOW = Date.parse("2026-10-29T16:42:00Z");

export const at = (min: number, from = NOW): string => new Date(from - min * 60_000).toISOString();

export const hub = (id: string, over: Partial<HubAccount> = {}): HubAccount => ({
  id,
  label: id === "local" ? "This computer" : `Hub ${id}`,
  url: `http://${id}.test`,
  local: id === "local",
  revision: `t-${id}`,
  ...over,
});

export const agent = (id: string, name = id): Who => ({ kind: "agent", id, name, engine: null });
export const session = (id: string, name = id): Who => ({ kind: "session", id, name, engine: "claude" });

export const need = (id: string, who: Who, over: Partial<Need> = {}): Need => ({
  id,
  kind: "question",
  who,
  ask: "Which branch?",
  options: null,
  since: at(10),
  place: who.kind === "session" ? { kind: "session" } : { kind: "dm" },
  answer: { kind: "reply" },
  ...over,
});

export const approval = (id: string, sessionId: string, over: Partial<Need> = {}): Need =>
  need(id, session(sessionId), {
    kind: "approval",
    ask: "Run npm test?",
    answer: { kind: "decide", at: { kind: "session", sessionId, approvalId: id } },
    ...over,
  });

export const work = (who: Who, over: Partial<Work> = {}): Work => ({
  who,
  what: "● Bash cargo test",
  place: who.kind === "session" ? { kind: "session" } : { kind: "dm" },
  since: at(30),
  heardAt: at(1),
  endedAt: null,
  outcome: null,
  background: null,
  ...over,
});

export const view = (over: Partial<FloorView> = {}): FloorView => ({
  asOf: new Date(NOW).toISOString(),
  needs: [],
  working: [],
  done: [],
  lanes: [],
  counts: { working: 0, needsYou: 0, doneToday: 0 },
  more: { done: 0, lanes: 0 },
  ...over,
});

export const ready = (floor: FloorView, over: Partial<HubFloor> = {}): HubFloor => ({
  state: "ready",
  floor,
  usage: null,
  offset: 0,
  stale: false,
  at: floor.asOf,
  ...over,
});

/** A hub as the floor's routes see it, driven by the test: `floor` null is a
 *  hub without the route; `down` one that can't be reached. */
export interface FakeHub {
  floor: FloorView | null;
  usage: UsageView | null;
  down: boolean;
  /** The decide route's answer, by status. */
  decide: (body: { at: unknown; choice: string }) => number;
  /** Each floor read's `day`. */
  days: string[];
  decided: { at: unknown; choice: string }[];
}

export const fakeHub = (over: Partial<FakeHub> = {}): FakeHub => ({
  floor: view(),
  usage: null,
  down: false,
  decide: () => 204,
  days: [],
  decided: [],
  ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** `fetch` for hubs at `http://<id>.test`. */
export const fakeFetch = (hubs: Record<string, FakeHub>) =>
  vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const h = hubs[url.hostname.replace(/\.test$/, "")];
    if (!h || h.down) throw new TypeError("Failed to fetch");
    const route = `${init?.method ?? "GET"} ${url.pathname}`;
    if (route === "GET /api/desk/floor") {
      h.days.push(url.searchParams.get("day") ?? "");
      return h.floor ? json({ ...h.floor, asOf: new Date().toISOString() }) : new Response("Not Found", { status: 404 });
    }
    if (route === "GET /api/desk/usage")
      return h.usage ? json({ ...h.usage, asOf: new Date().toISOString() }) : new Response("Not Found", { status: 404 });
    if (route === "POST /api/desk/needs/decide") {
      const body = JSON.parse(String(init?.body)) as { at: unknown; choice: string };
      h.decided.push(body);
      const status = h.decide(body);
      return status === 204 ? new Response(null, { status }) : json({ error: status === 409 ? "already_answered" : "not_yours" }, status);
    }
    return new Response("Not Found", { status: 404 });
  });
