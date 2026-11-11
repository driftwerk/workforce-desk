// The board end to end against a fake hub: Desk's own client over a
// transport that answers the board's routes as the hub does, and its events
// socket. Cards move by keyboard and come back from the hub where it put
// them; the filters, search and the settled shelf; the ticket's panel with
// its needs, assignment, pin, drop, history and spend; the session's chip.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { ActivityEvent, DeskEvent, LedgerRow, Session, Ticket, TicketState } from "../hub/types";
import { lined } from "../line/testing";
import { useOverview } from "../overview/store";
import { SETTLE_AFTER_MS } from "./board";
import { Board } from "./BoardView";
import { useBoard } from "./store";
import { OpenTicket } from "./TicketDetail";
import { SessionTicketChip, TicketKeys } from "./TicketChip";
import { ACME, API, WEB, ticket } from "./testing";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(), unregister: vi.fn() }));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));

class Socket implements DeskSocket {
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  say(e: DeskEvent) {
    this.onmessage?.({ data: JSON.stringify(e) } as MessageEvent);
  }
}

const json = (body: unknown, status = 200) =>
  status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const AT = "2026-11-05T15:05:00Z";

/** The hub, as far as the board goes: Acme's tickets, moved, linked,
 *  given out and recorded as it would. */
class FakeHub implements DeskTransport {
  tickets = new Map<string, Ticket>();
  requests: { route: string; body: Record<string, unknown> }[] = [];
  history: ActivityEvent[] = [];
  ledger: LedgerRow[] = [];
  refuseMoves = false;
  /** Runs as a request arrives, before the hub answers: what happens meanwhile. */
  meanwhile: ((route: string) => void) | null = null;
  /** History older than the first page, for Show older. */
  olderHistory: ActivityEvent[] = [];
  /** Every ledger page says there's another. */
  endlessLedger = false;
  /** Tickets lists asked for: each one a change is heard during. */
  ticketReads = 0;
  churnReads = 0;
  events: Socket | null = null;
  sessions: Session[] = [];

  put(t: Ticket) {
    this.tickets.set(t.id, t);
    this.events?.say({ type: "ticket", ticket: t });
    return t;
  }

  fetch = async (method: string, path: string, body?: { data: string | Blob }): Promise<Response> => {
    const route = `${method} ${path}`;
    const said = body ? (JSON.parse(String(body.data)) as Record<string, unknown>) : {};
    this.requests.push({ route, body: said });
    this.meanwhile?.(route);
    const [p, query = ""] = path.split("?");
    const q = new URLSearchParams(query);
    if (route === "GET /api/desk/boards") return json([ACME]);
    if (route === `GET /api/desk/boards/${ACME.id}/tickets`) {
      const list = [...this.tickets.values()];
      if (this.ticketReads++ < this.churnReads) this.put({ ...list[0]!, title: `Changed while read ${this.ticketReads}` });
      return json(list);
    }
    if (method === "GET" && p === "/api/desk/tickets/search") return json([...this.tickets.values()].filter((t) => t.key === q.get("q") || t.title.includes(q.get("q") ?? "")));
    if (method === "GET" && p === "/api/desk/ledger")
      return json({ rows: q.get("before") ? [] : this.ledger.filter((r) => r.session === q.get("session")), next: this.endlessLedger ? "more" : null });
    const m = /^\/api\/desk\/tickets\/([^/]+)(?:\/(\w+))?(?:\/([^/]+))?$/.exec(p!);
    const t = m ? this.tickets.get(m[1]!) : undefined;
    if (m && !t) return json({ error: "There's no such ticket or board." }, 404);
    if (t && m) {
      const [, , verb, other] = m;
      if (method === "GET" && !verb) return json(t);
      if (method === "GET" && verb === "history")
        return q.get("before")
          ? json({ events: this.olderHistory, more: false })
          : json({ events: this.history.filter((e) => e.ticket === t.id), more: this.olderHistory.length > 0 });
      if (method === "POST" && verb === "move") {
        if (this.refuseMoves) return json({ error: "That ticket changed while this was being done; look at it again." }, 409);
        const state = said.state as TicketState;
        const below = said.after ? this.tickets.get(String(said.after))?.rank : undefined;
        const above = said.before ? this.tickets.get(String(said.before))?.rank : undefined;
        const rank = above !== undefined && below !== undefined ? (above + below) / 2 : below !== undefined ? below - 1024 : (above ?? 0) + 1024;
        return json(this.put({ ...t, state, rank, stateAt: state === t.state ? t.stateAt : AT, updatedAt: AT }));
      }
      if (method === "PATCH" && !verb) {
        const changed = { ...t, ...said, snoozed: !!said.snoozedUntil, updatedAt: AT };
        this.tickets.set(t.id, changed);
        return json(changed);
      }
      if (verb === "needs" && other) {
        const needs = method === "PUT" ? [...t.needs, other] : t.needs.filter((n) => n !== other);
        return json(this.put({ ...t, needs, updatedAt: AT }));
      }
      if (method === "POST" && verb === "assign") {
        const to = said.to as { session?: string } | null;
        const assignee = to?.session ? (to.session === WEB.id ? WEB : API) : null;
        return json(this.put({ ...t, assignee, state: assignee ? "doing" : t.state, updatedAt: AT }));
      }
    }
    return new Response("Not Found", { status: 404 });
  };

  socket = (path: string): DeskSocket => {
    const s = new Socket();
    if (path === "/api/desk/events") this.events = s;
    return s;
  };
}

let hub: FakeHub;
let disconnect: () => void;

const connect = async () => {
  disconnect = useDesk.getState().connect(hub);
  await act(async () => {
    await Promise.resolve();
    hub.events!.say({ type: "snapshot", sessions: hub.sessions, restore: [], rooms: [] });
  });
  await waitFor(() => expect(useBoard.getState().supported).toBe(true));
};

const column = (title: string) => screen.getByRole("region", { name: title });
const cardsIn = (title: string) => within(column(title)).queryAllByRole("button", { name: /^ACM-\d+:/ }).map((b) => b.getAttribute("aria-label")!.split(":")[0]);
const moves = () => hub.requests.filter((r) => r.route.endsWith("/move"));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  hub = new FakeHub();
  useBoard.setState({ boards: {}, tickets: {}, supported: null, shown: null, open: null });
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }], roster: [] });
  useOverview.setState({ manager: null, managerSupport: "no", overviewSupport: "no", suggestions: {}, suggestionsLoaded: true });
  useDesk.setState({ error: null });
});
afterEach(() => {
  disconnect?.();
  cleanup();
  vi.unstubAllGlobals();
});

describe("the board", () => {
  it("shows its five columns, each by rank, with Done's settled tickets folded away until asked", async () => {
    const old = new Date(Date.now() - SETTLE_AFTER_MS - 60_000).toISOString();
    // Done a minute ago, read against the real clock as `old` is: never the
    // fixture's fixed time, which settles once three days have passed.
    const lately = new Date(Date.now() - 60_000).toISOString();
    for (const t of [
      ticket(15, { title: "Retire the legacy routes", rank: 2048 }),
      ticket(16, { rank: 1024 }),
      ticket(13, { state: "todo", pinned: true }),
      ticket(12, { state: "doing" }),
      ticket(10, { state: "done", stateAt: old }),
      ticket(11, { state: "done", stateAt: lately }),
      ticket(9, { state: "dropped" }),
    ])
      hub.tickets.set(t.id, t);
    await connect();
    render(<Board />);
    expect(screen.getByRole("heading", { name: "Acme board" })).toBeTruthy();
    expect(cardsIn("Backlog")).toEqual(["ACM-16", "ACM-15"]);
    expect(cardsIn("To do")).toEqual(["ACM-13"]);
    expect(within(column("To do")).getByText("Pinned")).toBeTruthy();
    expect(cardsIn("Doing")).toEqual(["ACM-12"]);
    expect(cardsIn("Review")).toEqual([]);
    expect(cardsIn("Done")).toEqual(["ACM-11"]);
    expect(within(column("Done")).getByLabelText("3 tickets")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "2 more, settled after 3 days" }));
    expect(cardsIn("Done")).toEqual(["ACM-11", "ACM-9", "ACM-10"]);
  });

  it("filters to what waits on you or is pinned, and finds a typed key", async () => {
    hub.sessions = [lined({ id: WEB.id, name: "acme-web", state: "asking" }), lined({ id: API.id, name: "acme-api", state: "working" })];
    for (const t of [
      ticket(9, { state: "doing", assignee: WEB, title: "Move leads onto the new service" }),
      ticket(12, { state: "doing", assignee: API }),
      ticket(11, { state: "review" }),
      ticket(13, { state: "todo", pinned: true }),
    ])
      hub.tickets.set(t.id, t);
    await connect();
    render(<Board />);
    const nine = screen.getByRole("button", { name: /^ACM-9:/ });
    expect(nine.className).toContain("board-card-waiting");
    expect(within(nine).getByText("asked you something")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Waiting on me · 2" }));
    expect([...cardsIn("Doing"), ...cardsIn("Review"), ...cardsIn("To do")]).toEqual(["ACM-9", "ACM-11"]);
    fireEvent.click(screen.getByRole("button", { name: "Pinned" }));
    expect([...cardsIn("Doing"), ...cardsIn("To do")]).toEqual(["ACM-13"]);
    fireEvent.click(screen.getByRole("button", { name: "Everyone" }));
    const search = screen.getByRole("textbox", { name: "Search tickets" });
    fireEvent.change(search, { target: { value: "acm-12" } });
    expect(cardsIn("Doing")).toEqual(["ACM-12"]);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(useBoard.getState().open).toBe("t12");
  });

  it("says what a To do ticket is blocked by, until its need is done", async () => {
    hub.tickets.set("t1", ticket(1, { state: "doing" }));
    hub.tickets.set("t2", ticket(2, { state: "todo", needs: ["t1"], blockers: ["t1"] }));
    await connect();
    render(<Board />);
    const two = () => screen.getByRole("button", { name: /^ACM-2:/ });
    expect(within(two()).getByText("Blocked by ACM-1").className).toContain("state-blocked");
    await act(async () => void hub.put({ ...hub.tickets.get("t1")!, state: "done" }));
    expect(within(two()).queryByText(/Blocked by/)).toBeNull();
  });

  it("moves a card with Alt+arrows: the hub is told where, and the card stays where the hub put it", async () => {
    for (const t of [ticket(1, { state: "todo" }), ticket(2, { state: "todo" }), ticket(3, { state: "doing" })]) hub.tickets.set(t.id, t);
    await connect();
    render(<Board />);
    await act(async () => void fireEvent.keyDown(screen.getByRole("button", { name: /^ACM-1:/ }), { key: "ArrowRight", altKey: true }));
    expect(moves().at(-1)).toEqual({ route: "POST /api/desk/tickets/t1/move", body: { state: "doing", before: "t3" } });
    await waitFor(() => expect(cardsIn("Doing")).toEqual(["ACM-3", "ACM-1"]));
    expect(cardsIn("To do")).toEqual(["ACM-2"]);
    expect(hub.tickets.get("t1")!.state).toBe("doing");
    await act(async () => void fireEvent.keyDown(screen.getByRole("button", { name: /^ACM-1:/ }), { key: "ArrowUp", altKey: true }));
    expect(moves().at(-1)!.body).toEqual({ state: "doing", after: "t3" });
    await waitFor(() => expect(cardsIn("Doing")).toEqual(["ACM-1", "ACM-3"]));
    // Already at the top: nothing is asked.
    const asked = moves().length;
    fireEvent.keyDown(screen.getByRole("button", { name: /^ACM-1:/ }), { key: "ArrowUp", altKey: true });
    expect(moves().length).toBe(asked);
  });

  it("puts a card back where it was when the hub refuses the move, and says why", async () => {
    for (const t of [ticket(1, { state: "todo" }), ticket(3, { state: "doing" })]) hub.tickets.set(t.id, t);
    hub.refuseMoves = true;
    await connect();
    render(<Board />);
    await act(async () => void fireEvent.keyDown(screen.getByRole("button", { name: /^ACM-1:/ }), { key: "ArrowRight", altKey: true }));
    await waitFor(() => expect(useDesk.getState().error).toMatch(/changed while this was being done/));
    expect(cardsIn("To do")).toEqual(["ACM-1"]);
    expect(cardsIn("Doing")).toEqual(["ACM-3"]);
  });

  it("follows the hub: a ticket a session moved, and one deleted", async () => {
    hub.tickets.set("t1", ticket(1, { state: "doing" }));
    hub.tickets.set("t2", ticket(2));
    await connect();
    render(<Board />);
    await act(async () => void hub.put({ ...hub.tickets.get("t1")!, state: "review" }));
    expect(cardsIn("Review")).toEqual(["ACM-1"]);
    await act(async () => hub.events!.say({ type: "ticketRemoved", id: "t2" }));
    expect(cardsIn("Backlog")).toEqual([]);
  });
});

describe("a ticket's panel", () => {
  const open = async () => {
    hub.sessions = [lined({ id: WEB.id, name: "acme-web", state: "working" }), lined({ id: API.id, name: "acme-api", state: "idle" })];
    hub.tickets.set("t10", ticket(10, { state: "done", title: "Note service on the new runtime" }));
    hub.tickets.set("t12", ticket(12, { state: "doing", title: "Hash every partner key at rest", assignee: WEB, needs: ["t10"], links: [{ kind: "pr", number: 491, url: "https://example.test/pr/491" }] }));
    hub.tickets.set("t15", ticket(15, { title: "Retire the legacy routes", needs: ["t12"] }));
    hub.tickets.set("t16", ticket(16, { title: "Rate-limit partner key lookups" }));
    hub.history = [
      { id: "e3", at: "2026-11-05T15:05:00Z", kind: "ticket_commented", actor: WEB, text: "commented on ACM-12: “Both…”", ticket: "t12", detail: { comment: "Both gateways already hash; checking partner keys." } },
      { id: "e2", at: "2026-11-05T14:20:00Z", kind: "ticket_assigned", actor: { kind: "you", id: "you", name: "You" }, subject: WEB, text: "gave ACM-12 to acme-web", ticket: "t12" },
      { id: "e1", at: "2026-11-05T14:02:00Z", kind: "ticket_created", actor: { kind: "you", id: "you", name: "You" }, text: "created ACM-12 “Hash every partner key at rest”", ticket: "t12" },
    ];
    const row = (key: string, ticketId: string | null, usd: number): LedgerRow => ({
      session: WEB.id,
      key,
      at: AT,
      engine: "claude",
      model: "m",
      tokens: { input: 200_000, output: 6_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      usd,
      priced: "priced",
      billing: "plan",
      account: null,
      ticket: ticketId,
    });
    hub.ledger = [row("a", "t12", 1.6), row("b", "t12", 1.5), row("c", null, 9)];
    await connect();
    render(
      <>
        <SessionTicketChip session={WEB.id} />
        <OpenTicket />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open ticket ACM-12: Hash every partner key at rest" }));
    return screen.findByRole("complementary", { name: "Ticket ACM-12" });
  };

  it("opens from the session's chip with its state, who has it, needs, links, history and spend", async () => {
    const panel = await open();
    expect(within(panel).getByRole("heading", { name: "Hash every partner key at rest" })).toBeTruthy();
    expect((within(panel).getByLabelText("State") as HTMLSelectElement).value).toBe("doing");
    expect(within(panel).getByText("acme-web", { selector: ".board-who-name" })).toBeTruthy();
    const needs = within(panel).getByRole("region", { name: "Needs" });
    expect(within(needs).getByRole("button", { name: /ACM-10.*Note service.*Done/ })).toBeTruthy();
    expect(within(needs).getByRole("button", { name: /ACM-15.*Retire the legacy routes.*Backlog/ })).toBeTruthy();
    expect(within(panel).getByText("PR #491")).toBeTruthy();
    const history = within(panel).getByRole("region", { name: "History" });
    // The time as this computer says it, whatever its locale, then the words.
    const rows = within(history)
      .getAllByRole("listitem")
      .map((li) => li.textContent!.slice(li.querySelector("time")!.textContent!.length));
    expect(rows).toEqual(["You created it", "You gave it to acme-web", "acme-web noted “Both gateways already hash; checking partner keys.”"]);
    await waitFor(() => expect(within(history).getByText("412k tokens · $3.10 this month")).toBeTruthy());
  });

  it("adds and drops a need, hands the ticket on, pins it and drops it, each through the hub", async () => {
    const panel = await open();
    const needs = within(panel).getByRole("region", { name: "Needs" });
    fireEvent.click(within(needs).getByRole("button", { name: "Add another need…" }));
    fireEvent.change(within(needs).getByRole("textbox", { name: "A ticket it needs" }), { target: { value: "Rate-limit" } });
    fireEvent.click(await within(needs).findByRole("button", { name: /ACM-16/ }));
    await waitFor(() => expect(hub.requests.some((r) => r.route === "PUT /api/desk/tickets/t12/needs/t16")).toBe(true));
    await waitFor(() => expect(useBoard.getState().tickets.t12!.needs).toEqual(["t10", "t16"]));
    fireEvent.click(within(needs).getByRole("button", { name: "It no longer needs ACM-10" }));
    await waitFor(() => expect(useBoard.getState().tickets.t12!.needs).toEqual(["t16"]));
    expect(hub.requests.some((r) => r.route === "DELETE /api/desk/tickets/t12/needs/t10")).toBe(true);

    fireEvent.click(within(panel).getByRole("button", { name: "Hand to…" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /acme-api/ }));
    await waitFor(() => expect(hub.requests.find((r) => r.route === "POST /api/desk/tickets/t12/assign")?.body).toEqual({ to: { session: API.id } }));
    await waitFor(() => expect(useBoard.getState().tickets.t12!.assignee?.id).toBe(API.id));
    // The session it went to wears its key; the one it left doesn't.
    render(<SessionTicketChip session={API.id} />);
    expect(screen.getAllByRole("button", { name: /^Open ticket ACM-12/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^Open ticket ACM-12/ }).closest("aside")).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(hub.requests.find((r) => r.route === "PATCH /api/desk/tickets/t12")?.body).toEqual({ pinned: true }));
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Pinned" }).getAttribute("aria-pressed")).toBe("true"));

    fireEvent.click(within(panel).getByRole("button", { name: "Drop" }));
    await waitFor(() => expect(moves().at(-1)).toEqual({ route: "POST /api/desk/tickets/t12/move", body: { state: "dropped" } }));
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Bring it back" })).toBeTruthy());
  });

  it("says its spend is at least what was read when a session's ledger has more pages, and doesn't read it again on every change", async () => {
    hub.endlessLedger = true;
    const panel = await open();
    const history = within(panel).getByRole("region", { name: "History" });
    await waitFor(() => expect(within(history).getByText("at least 412k tokens · $3.10 this month")).toBeTruthy());
    const reads = hub.requests.filter((r) => r.route.startsWith("GET /api/desk/ledger")).length;
    await act(async () => void hub.put({ ...hub.tickets.get("t12")!, title: "Hash keys", updatedAt: "2026-11-05T15:10:00Z" }));
    await act(async () => void hub.put({ ...hub.tickets.get("t12")!, pinned: true, updatedAt: "2026-11-05T15:11:00Z" }));
    expect(hub.requests.filter((r) => r.route.startsWith("GET /api/desk/ledger")).length).toBe(reads);
  });

  it("keeps older history it showed when the ticket changes and its history is read again", async () => {
    hub.olderHistory = [{ id: "e0", at: "2026-11-04T09:00:00Z", kind: "ticket_edited", actor: { kind: "you", id: "you", name: "You" }, text: "made ACM-12 need ACM-10", ticket: "t12" }];
    const panel = await open();
    const history = within(panel).getByRole("region", { name: "History" });
    fireEvent.click(await within(history).findByRole("button", { name: "Show older" }));
    await waitFor(() => expect(within(history).getAllByRole("listitem")).toHaveLength(4));
    await act(async () => void hub.put({ ...hub.tickets.get("t12")!, title: "Hash keys", updatedAt: "2026-11-05T15:10:00Z" }));
    await waitFor(() => expect(hub.requests.filter((r) => r.route === "GET /api/desk/tickets/t12/history").length).toBe(2));
    expect(within(history).getAllByRole("listitem")).toHaveLength(4);
    expect(within(history).getAllByRole("listitem")[0]!.textContent).toContain("made it need ACM-10");
    expect(within(history).queryByRole("button", { name: "Show older" })).toBeNull();
  });
});

describe("a ticket's key in a room message", () => {
  it("is its chip, opening the ticket; a key no board has stays words", () => {
    useBoard.setState({ tickets: { t12: ticket(12, { title: "Hash every partner key at rest" }) } });
    render(
      <p>
        <TicketKeys text="Take ACM-12 after XYZ-3." />
      </p>,
    );
    expect(screen.getByText(/XYZ-3\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open ticket ACM-12: Hash every partner key at rest" }));
    expect(useBoard.getState().open).toBe("t12");
  });
});

describe("when the hub and Desk cross", () => {
  it("keeps what a session did meanwhile when the hub refuses a move, and says why in the hub's words", async () => {
    for (const t of [ticket(1, { state: "todo" }), ticket(3, { state: "doing" })]) hub.tickets.set(t.id, t);
    hub.refuseMoves = true;
    await connect();
    render(<Board />);
    // A session moves it to Review just before Desk's move is refused.
    hub.meanwhile = (route) => {
      if (route.endsWith("/move")) hub.put({ ...hub.tickets.get("t1")!, state: "review" });
    };
    await act(async () => void fireEvent.keyDown(screen.getByRole("button", { name: /^ACM-1:/ }), { key: "ArrowRight", altKey: true }));
    await waitFor(() => expect(useDesk.getState().error).toBe("That ticket changed while this was being done; look at it again."));
    expect(cardsIn("Review")).toEqual(["ACM-1"]);
    expect(cardsIn("Doing")).toEqual(["ACM-3"]);
  });

  it("reads a refused ticket again rather than guessing how it was", async () => {
    hub.tickets.set("t1", ticket(1, { state: "todo" }));
    hub.refuseMoves = true;
    await connect();
    render(<Board />);
    // The hub has it in Backlog by now, without a word on the socket.
    hub.tickets.set("t1", { ...hub.tickets.get("t1")!, state: "backlog" });
    await act(async () => void fireEvent.keyDown(screen.getByRole("button", { name: /^ACM-1:/ }), { key: "ArrowRight", altKey: true }));
    await waitFor(() => expect(cardsIn("Backlog")).toEqual(["ACM-1"]));
    expect(hub.requests.some((r) => r.route === "GET /api/desk/tickets/t1")).toBe(true);
  });

  it("drops the hub's answer to a pin when the ticket changed after the pin was asked", async () => {
    hub.tickets.set("t1", ticket(1, { state: "doing" }));
    await connect();
    render(<Board />);
    hub.meanwhile = (route) => {
      // A session's move, announced before the pin's answer (which, read
      // before it, still says Doing) comes back.
      if (route === "PATCH /api/desk/tickets/t1") hub.events!.say({ type: "ticket", ticket: { ...hub.tickets.get("t1")!, state: "review", updatedAt: "2026-11-05T15:06:00Z" } });
    };
    await act(async () => useBoard.getState().edit("t1", { pinned: true }));
    expect(useBoard.getState().tickets.t1!.state).toBe("review");
  });

  it("keeps what it read once changes keep coming, with each change heard on top, and never offers to make a board meanwhile", async () => {
    hub.tickets.set("t1", ticket(1, { title: "First" }));
    hub.tickets.set("t2", ticket(2));
    hub.churnReads = 10;
    render(<Board />);
    expect(screen.queryByRole("button", { name: "Make a board" })).toBeNull();
    disconnect = useDesk.getState().connect(hub);
    await act(async () => {
      await Promise.resolve();
      hub.events!.say({ type: "snapshot", sessions: [], restore: [], rooms: [] });
    });
    await waitFor(() => expect(useBoard.getState().supported).toBe(true));
    expect(hub.ticketReads).toBe(3);
    expect(useBoard.getState().tickets.t1!.title).toBe("Changed while read 3");
    expect(cardsIn("Backlog")).toEqual(["ACM-1", "ACM-2"]);
  });

  it("never moves a dropped ticket by keys or drag: it comes back by Bring it back", async () => {
    hub.tickets.set("t9", ticket(9, { state: "dropped" }));
    await connect();
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "1 more, settled after 3 days" }));
    fireEvent.keyDown(screen.getByRole("button", { name: /^ACM-9:/ }), { key: "ArrowLeft", altKey: true });
    expect(moves()).toEqual([]);
    expect(screen.getByText("ACM-9 is dropped: Bring it back from its panel first")).toBeTruthy();
  });

  it("moves a card among the filtered ones to its place in the whole column", async () => {
    for (const t of [ticket(1, { state: "todo", rank: 1000 }), ticket(2, { state: "todo", rank: 2000, pinned: true }), ticket(3, { state: "todo", rank: 3000 }), ticket(4, { state: "todo", rank: 4000, pinned: true })])
      hub.tickets.set(t.id, t);
    await connect();
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Pinned" }));
    await act(async () => void fireEvent.keyDown(screen.getByRole("button", { name: /^ACM-4:/ }), { key: "ArrowUp", altKey: true }));
    expect(moves().at(-1)!.body).toEqual({ state: "todo", before: "t1", after: "t2" });
  });
});

describe("a ticket a session wrote", () => {
  it("says so on its card in every column and in its panel", async () => {
    hub.sessions = [lined({ id: API.id, name: "acme-api", state: "working" })];
    hub.tickets.set("t17", ticket(17, { title: "Flaky webhook test", createdBy: API }));
    hub.tickets.set("t18", ticket(18, { title: "Retry the webhook", createdBy: API, state: "doing", assignee: WEB }));
    await connect();
    render(
      <>
        <Board />
        <OpenTicket />
      </>,
    );
    expect(within(screen.getByRole("button", { name: /^ACM-17:/ })).getByText("acme-api added this")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /^ACM-18:/ })).getByText("by acme-api")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^ACM-18:/ }));
    const panel = await screen.findByRole("complementary", { name: "Ticket ACM-18" });
    expect(within(panel).getByText(/^Written by/).textContent).toBe("Written by acme-api: its title and description are its words, not yours.");
  });
});

describe("editing a ticket another changed meanwhile", () => {
  const edited = async () => {
    hub.tickets.set("t1", ticket(1, { title: "Hash keys" }));
    await connect();
    render(<OpenTicket />);
    act(() => useBoard.getState().openTicket("t1"));
    const panel = await screen.findByRole("complementary", { name: "Ticket ACM-1" });
    fireEvent.click(within(panel).getByRole("button", { name: "Hash keys" }));
    const field = within(panel).getByRole("textbox", { name: "Title" });
    fireEvent.change(field, { target: { value: "Hash partner keys" } });
    await act(async () => void hub.put({ ...hub.tickets.get("t1")!, title: "Hash every key at rest" }));
    fireEvent.blur(field);
    return panel;
  };

  it("shows the newer words and saves the person's only if they keep theirs", async () => {
    const panel = await edited();
    expect(within(panel).getByRole("alert").textContent).toContain("Changed meanwhile. The title now says:Hash every key at rest");
    expect(hub.requests.some((r) => r.route === "PATCH /api/desk/tickets/t1")).toBe(false);
    fireEvent.click(within(panel).getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(hub.requests.find((r) => r.route === "PATCH /api/desk/tickets/t1")?.body).toEqual({ title: "Hash partner keys" }));
  });

  it("takes the new words without a word to the hub", async () => {
    const panel = await edited();
    fireEvent.click(within(panel).getByRole("button", { name: "Take the new one" }));
    expect(within(panel).queryByText(/Changed meanwhile/)).toBeNull();
    expect(within(panel).getByRole("heading", { name: "Hash every key at rest" })).toBeTruthy();
    expect(hub.requests.some((r) => r.route === "PATCH /api/desk/tickets/t1")).toBe(false);
  });
});
