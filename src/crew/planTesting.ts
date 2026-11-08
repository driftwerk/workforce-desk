// A hub's plans, for tests: Acme's boss Sarah proposes a plan of four
// tickets on Acme's board, and the routes answer as the hub's do. Approving
// it (by the plan's route or the Floor's decide) moves its tickets to To do
// and starts the ready ones, as the runner would, announcing each.

import { vi } from "vitest";
import type { BossPlan, BossPlanDetail, BossPlanRevision, BossPlanTicket, DeskEvent, DraftTicket, EngineInfo, Need, PlannedTicket, Ticket, TicketState } from "../hub/types";

export const PLAN = "00000000-0000-4000-8000-00000000aa01";
export const BOARD = "board-acme";
export const AT = "2026-11-08T10:03:00.000Z";

const SARAH = { kind: "manager" as const, id: "sarah", name: "Sarah" };

let clock = Date.parse(AT);
const tick = (): string => new Date((clock += 1000)).toISOString();

export const ticket = (n: number, title: string, over: Partial<BossPlanTicket> = {}): BossPlanTicket => ({
  id: `t${n}`,
  board: BOARD,
  number: n,
  title,
  body: "",
  state: "backlog",
  rank: n * 1024,
  assignee: null,
  needs: [],
  links: [],
  createdBy: SARAH,
  pinned: false,
  snoozedUntil: null,
  stateAt: AT,
  createdAt: AT,
  updatedAt: AT,
  key: `ACM-${n}`,
  ready: false,
  blockers: [],
  settled: false,
  snoozed: false,
  engine: "claude",
  folder: "/Users/sam/code/acme-api",
  view: null,
  starting: false,
  ...over,
});

/** Refunds, as Sarah proposed it: the endpoint and the admin button side
 *  by side, the order page after the endpoint, the test last. */
export const refunds = (): BossPlanTicket[] => [
  ticket(20, "Refunds endpoint over Stripe refunds"),
  ticket(21, "Refund button in admin", { engine: "codex", folder: "/Users/sam/code/acme-admin" }),
  ticket(22, "Refund from the order page", { needs: ["t20"], folder: "/Users/sam/code/acme-web" }),
  ticket(23, "End-to-end refund test in CI", { needs: ["t21", "t22"], folder: "/Users/sam/code/acme-web" }),
];

const planned = (t: BossPlanTicket): PlannedTicket => ({ id: t.id, title: t.title, body: t.body, engine: t.engine ?? "claude", folder: t.folder ?? "", view: t.view, needs: t.needs });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const engines = (): EngineInfo[] =>
  (["claude", "codex", "devin"] as const).map((engine) => ({
    engine,
    title: engine,
    program: engine === "devin" ? null : `/usr/local/bin/${engine}`,
    installed: engine !== "devin",
    version: "1",
    signIn: { state: "in", via: "plan", who: null, plan: null },
    views: ["terminal"],
    caps: { terminal: { state: "hooks", approvals: "desk", resume: "byId", interrupt: "keys", plan: null, line: "submit", notes: [] } },
  }));

/** The hub's side of one plan. */
export class PlanHub {
  plan: BossPlanDetail;
  /** Each request, with its body. */
  requests: { route: string; body: unknown }[] = [];
  /** Where it announces what changed (the events socket). */
  say: (e: DeskEvent) => void = () => {};
  /** How many of the plan's sessions start at once. */
  limit = 2;
  /** The board's tickets in no plan. */
  others: Ticket[] = [];

  constructor(tickets: BossPlanTicket[] = refunds(), over: Partial<BossPlanDetail> = {}) {
    this.plan = {
      id: PLAN,
      board: BOARD,
      group: "acme",
      boss: "sarah",
      bossName: "Sarah",
      goal: "Refunds from the order page and from admin, covered by a test",
      state: "proposed",
      paused: null,
      parallel: null,
      revision: 1,
      approvedRevision: null,
      createdAt: AT,
      updatedAt: AT,
      progress: { done: 0, doing: 0, review: 0, ready: 0, blocked: 0, waiting: tickets.length, total: tickets.length, next: [] },
      tickets,
      waves: [],
      revisions: [],
      ...over,
    };
    this.plan.revisions = [this.revisionOf(1, SARAH, "scope", `Proposed ${tickets.length} tickets for “${this.plan.goal}”`)];
  }

  private revisionOf(n: number, by: BossPlanRevision["by"], change: "minor" | "scope", summary: string, tickets = this.plan.tickets, parallel?: number): BossPlanRevision {
    const snapshot = { goal: this.plan.goal, tickets: tickets.map(planned), ...(parallel !== undefined ? { parallel } : {}) };
    return { plan: PLAN, revision: n, at: tick(), by, change, summary, snapshot };
  }

  summary(): BossPlan {
    const { tickets: _t, waves: _w, revisions: _r, ...p } = this.plan;
    return p;
  }

  /** The floor's need for it, while it waits on the person. */
  need(): Need | null {
    const p = this.plan;
    const failing = p.state === "paused" && p.paused === "start_failing";
    if (p.state === "done" || p.state === "dropped" || (p.approvedRevision === p.revision && !failing)) return null;
    return {
      id: `plan:${p.id}`,
      kind: "approval",
      who: { kind: "manager", id: "sarah", name: "Sarah", engine: null },
      ask: failing
        ? `Sarah's plan keeps failing to start sessions: ${p.pausedWhy ?? ""}`
        : p.approvedRevision === null
          ? `Approve Sarah's plan: ${p.goal}`
          : `Plan change: ${p.revisions.at(-1)!.summary}`,
      why: `${p.tickets.length} tickets.`,
      options: null,
      since: AT,
      place: { kind: "dm" },
      answer: { kind: "decide", at: { kind: "plan", plan: p.id, revision: p.revision } },
    };
  }

  private touch() {
    this.plan.updatedAt = tick();
    this.say({ type: "plan", plan: this.summary() });
  }

  private move(t: BossPlanTicket, state: TicketState, over: Partial<Ticket> = {}) {
    Object.assign(t, { state, stateAt: tick(), updatedAt: tick(), ...over });
    const { engine: _e, folder: _f, view: _v, starting: _s, ...board } = t;
    this.say({ type: "ticket", ticket: board });
  }

  /** The person approves `revision`: refused unless it is the newest. */
  approve(revision: number): Response | null {
    const p = this.plan;
    if (revision !== p.revision) return json({ error: `Sarah changed the plan; look at revision ${p.revision}.` }, 409);
    // Its starts kept failing: Continue.
    if (p.state === "paused" && p.paused === "start_failing" && p.approvedRevision === revision) {
      Object.assign(p, { state: "running", paused: null, pausedWhy: null });
      this.touch();
      return null;
    }
    if (p.approvedRevision === null) for (const t of p.tickets) if (t.state === "backlog") this.move(t, "todo");
    p.state = "running";
    p.approvedRevision = revision;
    this.touch();
    // The runner: the ready tickets start, up to the limit.
    const done = new Set(p.tickets.filter((t) => t.state === "done").map((t) => t.id));
    const ready = p.tickets.filter((t) => t.state === "todo" && !t.assignee && t.needs.every((n) => done.has(n))).slice(0, this.limit);
    for (const t of ready) this.move(t, "doing", { assignee: { kind: "session", id: `s-${t.id}`, name: t.key! } });
    if (ready.length > 0) this.touch();
    return null;
  }

  /** Sarah adds a ticket: a change of scope, said to no one (no event). */
  bossAdds(title: string) {
    const p = this.plan;
    const added = ticket(19, title, { folder: "/Users/sam/code/acme-web" });
    const next = [...p.tickets, added];
    if (p.approvedRevision === null) p.tickets = next;
    p.revision += 1;
    p.revisions.push(this.revisionOf(p.revision, SARAH, "scope", `Added “${title}”`, next));
  }

  /** Sarah proposes `next` (the plan's tickets as she would have them) and
   *  `parallel`, as a change of scope that waits on the person. */
  bossProposes(summary: string, next: (tickets: BossPlanTicket[]) => BossPlanTicket[], parallel?: number) {
    const p = this.plan;
    p.revision += 1;
    p.revisions.push(this.revisionOf(p.revision, SARAH, "scope", summary, next(p.tickets.map((t) => ({ ...t }))), parallel));
  }

  /** The person turns down the boss's waiting change: the plan runs on as
   *  approved. */
  turnDown(revision: number): Response | null {
    const p = this.plan;
    if (revision !== p.revision || p.approvedRevision === null || p.approvedRevision === p.revision) return json({ error: "already_answered" }, 409);
    // Kept as approved, under a revision of its own.
    const was = p.revisions.at(-1)!;
    p.revision += 1;
    p.approvedRevision = p.revision;
    p.revisions.push(this.revisionOf(p.revision, { kind: "you", id: "you", name: "You" }, "scope", `Kept as approved, not: ${was.summary}`));
    this.touch();
    return null;
  }

  edit(body: { revision?: number; tickets?: DraftTicket[] }): Response {
    const p = this.plan;
    if (p.approvedRevision !== null && p.approvedRevision !== p.revision) return json({ error: "Approve or turn down Sarah's change first." }, 409);
    if (body.revision !== p.revision) return json({ error: `Sarah changed the plan; look at revision ${p.revision}.` }, 409);
    const tickets = body.tickets ?? [];
    let n = 30;
    const ids = tickets.map((d) => d.id ?? `t${n++}`);
    p.tickets = tickets.map((d, i) => {
      const was = p.tickets.find((t) => t.id === d.id);
      const base = was ?? ticket(Number(ids[i]!.slice(1)), d.title, { folder: d.folder });
      return { ...base, title: d.title, engine: d.engine ?? base.engine, folder: d.folder, needs: d.needs.map((k) => ids[k]!), rank: (i + 1) * 1024 };
    });
    p.revision += 1;
    p.revisions.push(this.revisionOf(p.revision, { kind: "you", id: "you", name: "You" }, "minor", "Changed the plan"));
    this.touch();
    return json({ plan: this.plan, change: "minor", applied: true, summary: "Changed the plan" });
  }

  /** Answers a plan route (or the Floor's decide of one); null for any other. */
  route(method: string, path: string, body: unknown): Response | null {
    const route = `${method} ${path.split("?")[0]}`;
    const base = `/api/desk/plans/${PLAN}`;
    if (route.includes("/api/desk/plans") || route === "POST /api/desk/needs/decide") this.requests.push({ route, body });
    const b = (body ?? {}) as Record<string, unknown>;
    switch (route) {
      case "GET /api/desk/plans":
        return json([this.summary()]);
      case `GET ${base}`:
        return json(this.plan);
      case `PATCH ${base}`:
        return this.edit(b as { revision?: number; tickets?: DraftTicket[] });
      // The gateway's token has no one to approve as: only the person's
      // device does, through the Floor's decide.
      case `POST ${base}/approve`:
        return json({ error: "not allowed" }, 403);
      case `POST ${base}/pause`:
        if (this.plan.state !== "running" && this.plan.state !== "paused") return json({ error: "Only a running plan can be paused." }, 409);
        Object.assign(this.plan, { state: "paused", paused: "person" });
        this.touch();
        return json(this.plan);
      case `POST ${base}/resume`:
        Object.assign(this.plan, { state: "running", paused: null });
        this.touch();
        return json(this.plan);
      case `POST ${base}/drop`:
        if (b.sessions !== "stop" && b.sessions !== "leave") return json({ error: "say what becomes of its sessions" }, 400);
        for (const t of this.plan.tickets) if (t.state !== "done" && (b.sessions === "stop" || (t.state !== "doing" && t.state !== "review"))) this.move(t, "dropped");
        Object.assign(this.plan, { state: "dropped", paused: null });
        this.touch();
        return json(this.plan);
      case "POST /api/desk/needs/decide": {
        const at = (b.at ?? {}) as { kind?: string; plan?: string; revision?: number };
        if (at.kind !== "plan" || at.plan !== PLAN) return null;
        // Answered with the plan as it now is.
        if (b.choice === "deny") {
          const p = this.plan;
          // A proposal denied is left as it is; a waiting change is turned down.
          if (p.approvedRevision === null) return json(this.plan);
          return this.turnDown(at.revision!) ?? json(this.plan);
        }
        return this.approve(at.revision!) ? json({ error: "already_answered" }, 409) : json(this.plan);
      }
      case "GET /api/desk/engines":
        return json(engines());
      case "GET /api/desk/boards":
        return json([{ id: BOARD, name: "Acme", group: "acme", prefix: "ACM", createdAt: AT, updatedAt: AT }]);
      case `GET /api/desk/boards/${BOARD}/tickets`:
        return json([...this.plan.tickets.map(({ engine: _e, folder: _f, view: _v, starting: _s, ...t }) => t), ...this.others]);
      default:
        return null;
    }
  }
}

/** `fetch` for this computer's hub at `http://local.test` as a paired hub
 *  is reached: the Floor's read of `plans`' need, and its decide. */
export const webFor = (plans: PlanHub, decided: unknown[] = []) =>
  async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const route = `${init?.method ?? "GET"} ${url.pathname}`;
    if (route === "GET /api/desk/floor") {
      const need = plans.need();
      return json({
        asOf: new Date().toISOString(),
        needs: need ? [need] : [],
        working: [],
        done: [],
        lanes: [],
        counts: { working: 0, needsYou: need ? 1 : 0, doneToday: 0 },
        more: { done: 0, lanes: 0 },
      });
    }
    if (route === "POST /api/desk/needs/decide") {
      const body = JSON.parse(String(init?.body));
      decided.push(body);
      return plans.route("POST", url.pathname, body) ?? json({ error: "not_yours" }, 403);
    }
    return new Response("Not Found", { status: 404 });
  };

/** The window as `IntersectionObserver` sees it, for tests: what a card
 *  watches is in view while `visible`, and `show` brings it there. */
export class FakeViewport {
  visible: boolean;
  private watched: { el: Element; cb: IntersectionObserverCallback; io: IntersectionObserver; gone: boolean }[] = [];

  constructor(visible = true) {
    this.visible = visible;
    const viewport = this;
    class Observer {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        const w = { el, cb: this.cb, io: this as unknown as IntersectionObserver, gone: false };
        viewport.watched.push(w);
        if (viewport.visible) viewport.fire(w);
      }
      unobserve() {}
      disconnect() {
        for (const w of viewport.watched) if (w.io === (this as unknown)) w.gone = true;
      }
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", Observer);
  }

  private fire(w: { el: Element; cb: IntersectionObserverCallback; io: IntersectionObserver; gone: boolean }) {
    const rect = { x: 0, y: 0, width: 600, height: 300, top: 0, left: 0, right: 600, bottom: 300 } as DOMRectReadOnly;
    w.cb([{ target: w.el, isIntersecting: true, intersectionRatio: 1, intersectionRect: rect, boundingClientRect: rect, rootBounds: rect, time: 0 }], w.io);
  }

  /** Scrolls everything watched into view. */
  show() {
    this.visible = true;
    for (const w of this.watched) if (!w.gone) this.fire(w);
  }
}
