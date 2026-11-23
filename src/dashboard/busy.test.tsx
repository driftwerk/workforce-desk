import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { FloorScope } from "../floor/scope";
import { useFloor } from "../floor/store";
import { approval, at, hub, need, NOW, ready, session as who, view } from "../floor/testing";
import { inWeek } from "../floor/workUsage";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { ActivityEvent, BossView, DeskEvent, Overview, Session } from "../hub/types";
import { lineOf } from "../overview/activity";
import { PAGE, useOverview } from "../overview/store";
import { useSettings } from "../settings/store";
import { useUi } from "../shell/ui";
import { FakeSocket } from "../testing/sockets";
import { badgeOfFloor } from "../unread/badges";
import { Dashboard } from "./Dashboard";

// The Dashboard while a dozen sessions run: what arrives unchanged costs
// nothing, a live event touches only its own row, and Activity stays a page
// while no one reads below its top or one group's part of it.

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));
vi.mock("../overview/activity", async (actual) => {
  const real = await actual<typeof import("../overview/activity")>();
  return { ...real, lineOf: vi.fn(real.lineOf) };
});
vi.mock("../unread/badges", async (actual) => {
  const real = await actual<typeof import("../unread/badges")>();
  return { ...real, badgeOfFloor: vi.fn(real.badgeOfFloor) };
});
vi.mock("../floor/workUsage", async (actual) => {
  const real = await actual<typeof import("../floor/workUsage")>();
  return { ...real, inWeek: vi.fn(real.inWeek) };
});

const SESSIONS = 12;
const HISTORY = 400;
/** One event in ten is Acme's, whose boss is Sarah. */
const ACME_EVERY = 10;

const running = (i: number, updatedAt = at(i)): Session =>
  ({ id: `s${i}`, engine: "claude", name: `web-${i}`, goal: `task ${i}`, cwd: "/work", origin: "desk", state: "working", live: true, createdAt: at(120), updatedAt }) as Session;

const party = (n: number) => ({ kind: "session" as const, id: `s${n % SESSIONS}`, name: `web-${n % SESSIONS}` });

/** The `n`th event back, `min` minutes ago: a request of s3's that still
 *  waits on you, a question of s4's, and the rest sessions starting. */
const event = (n: number, min: number, id = `e${String(n).padStart(3, "0")}`): ActivityEvent => {
  const base = { id, at: at(min), actor: party(n), subject: party(n), group: n % ACME_EVERY === 0 ? "acme" : null };
  if (n === 1) return { ...base, kind: "needs_you", actor: party(3), subject: party(3), approvalId: "ap-1", text: "wants to run npm test" };
  if (n === 2) return { ...base, kind: "question", actor: party(4), subject: party(4), text: "asked “Which branch?”" };
  return { ...base, kind: "started", text: `started ${id}` };
};

/** Everything the engine has, newest first. */
const history = Array.from({ length: HISTORY }, (_, i) => event(i + 1, (i + 1) / 10));

const overview: Overview = {
  brief: null,
  counts: { working: SESSIONS, needsYou: 0, doneToday: 0 },
  items: Array.from({ length: SESSIONS }, (_, i) => ({ kind: "session", id: `s${i}`, name: `web-${i}`, state: "working", detail: "● Bash npm test" })),
};

const boss = (agentId: string, name: string, group: string | null): BossView => ({
  scope: group ? { kind: "group", group } : { kind: "ungrouped" },
  agent: agentId,
  name,
  level: "act",
  state: "idle",
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** How often each of this computer's engine's routes was read. */
let reads: Record<string, number>;
/** What the engine answers for its overview: none, where it has none. */
let served: Overview | null;

/** A page of `history` as the engine pages it: before an event, `limit` at most. */
const activityPage = (query: URLSearchParams) => {
  const before = query.get("before");
  const from = before ? history.findIndex((e) => e.id === before) + 1 : 0;
  const events = history.slice(from, from + Number(query.get("limit") ?? PAGE));
  return { events, more: from + events.length < history.length };
};

const engine: DeskTransport = {
  fetch: async (method, path) => {
    const url = new URL(path, "http://local.test");
    const route = `${method} ${url.pathname}`;
    reads[route] = (reads[route] ?? 0) + 1;
    if (route === "GET /api/desk/overview") return served ? json(served) : new Response("Not Found", { status: 404 });
    if (route === "GET /api/desk/activity") return json(activityPage(url.searchParams));
    if (route === "GET /api/desk/manager") return json({ agentId: null, level: null });
    return new Response("Not Found", { status: 404 });
  },
  socket: (path) => new FakeSocket(`ws://local.test${path}`) as unknown as DeskSocket,
};

const says = (e: DeskEvent) => act(() => FakeSocket.find("/api/desk/events")!.receive(e));

/** Every session says it's still at it, as the engine's look every ten
 *  seconds once had each one do. */
const burst = async () => {
  for (let i = 0; i < SESSIONS; i++) await says({ type: "session", session: running(i, new Date().toISOString()) });
};

let live = 0;
const liveEvent = (group: string | null = null): DeskEvent => {
  live += 1;
  return { type: "activity", event: { ...event(5, 0, `live-${String(live).padStart(3, "0")}`), group } };
};

let commits: number;
let disconnect: () => void;

const rail = () => screen.getByRole("complementary", { name: "Activity" });
const scroller = () => rail().querySelector<HTMLElement>(".activity-scroll")!;
const rows = () => [...document.querySelectorAll<HTMLElement>(".ev-list [data-message-id]")];
const ids = () => rows().map((r) => r.dataset.messageId);
/** Scrolls Activity to `top`, of a list far taller than its pane. */
const scrollTo = (top: number) =>
  act(() => {
    const el = scroller();
    Object.defineProperties(el, { scrollHeight: { value: 10_000, configurable: true }, clientHeight: { value: 500, configurable: true } });
    el.scrollTop = top;
    fireEvent.scroll(el);
  });

/** Lets every read under way, and each it leads to, land. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(() => vi.advanceTimersByTimeAsync(10));
};

const dashboard = async (scope: string | null = null) => {
  render(
    <Profiler id="dashboard" onRender={() => void (commits += 1)}>
      <FloorScope.Provider value={scope}>
        <Dashboard onNewSession={() => {}} />
      </FloorScope.Provider>
    </Profiler>,
  );
  await act(() => vi.advanceTimersByTimeAsync(1000));
};

const spies = () => [lineOf, badgeOfFloor, inWeek].forEach((f) => vi.mocked(f).mockClear());

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  FakeSocket.reset();
  reads = {};
  served = overview;
  commits = 0;
  live = 0;
  useUi.setState({ activityOpen: true });
  useChat.setState({ hubs: [hub("local")], roster: [] });
  useSettings.setState({ groups: [{ id: "acme", name: "Acme", collapsed: false, items: ["session:s0"] }], ungrouped: { collapsed: false, items: [] } });
  useFloor.setState({
    hubs: {
      local: ready(
        view({
          needs: [approval("wait:t1:ap-1", "s3", { who: who("s3", "web-3") }), need("question:t2", who("s0", "web-0"), { group: "acme", boss: "sarah" })],
          bosses: [boss("desk", "Desk", null), boss("sarah", "Sarah", "acme")],
        }),
        { work: { asOf: new Date(NOW).toISOString(), works: [] } },
      ),
    },
    deciding: {},
    problems: {},
    answered: {},
  });
  useOverview.setState({ overview: null, overviewSupport: "unknown", activitySupport: "unknown", feeds: {}, manager: null, managerSupport: "unknown" });
  useDesk.setState({ sessions: {}, restore: [], rooms: {}, engines: {}, openId: null, view: "floor" });
  disconnect = useDesk.getState().connect(engine);
  await act(() => vi.advanceTimersByTimeAsync(0));
  await says({ type: "snapshot", sessions: Array.from({ length: SESSIONS }, (_, i) => running(i)), restore: [], rooms: [] });
  spies();
});
afterEach(() => {
  disconnect();
  cleanup();
  vi.useRealTimers();
});

describe("the Dashboard with a dozen sessions running", () => {
  it("leaves Activity and the Floor's cards be while the sessions report in", async () => {
    await dashboard();
    expect(rows()).toHaveLength(PAGE);
    const before = rows();
    const restore = useDesk.getState().restore;
    spies();
    await burst();
    expect(lineOf).not.toHaveBeenCalled();
    expect(badgeOfFloor).not.toHaveBeenCalled();
    expect(inWeek).not.toHaveBeenCalled();
    expect(rows().every((row, i) => row === before[i])).toBe(true);
    expect(useDesk.getState().restore).toBe(restore);
  });

  it("leaves them be on a Floor of one group too", async () => {
    await dashboard("acme");
    expect(rows().length).toBeGreaterThan(0);
    spies();
    await burst();
    expect(badgeOfFloor).not.toHaveBeenCalled();
    expect(inWeek).not.toHaveBeenCalled();
    expect(lineOf).not.toHaveBeenCalled();
  });

  it("draws nothing again for an overview read again that says the same", async () => {
    await dashboard();
    await burst();
    const shown = useOverview.getState().overview;
    const read = reads["GET /api/desk/overview"]!;
    commits = 0;
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(reads["GET /api/desk/overview"]).toBe(read + 1);
    expect(useOverview.getState().overview).toBe(shown);
    expect(commits).toBe(0);
  });

  it("puts a live event at the top without drawing the rows below it again, a request and a question too", async () => {
    await dashboard();
    const request = rows().find((r) => r.dataset.messageId === "e001")!;
    const question = rows().find((r) => r.dataset.messageId === "e002")!;
    expect(request.textContent).toContain("Still waiting on you");
    expect(question.textContent).toContain("Resolved");
    const before = rows();
    spies();
    await says(liveEvent());
    const after = rows();
    expect(after[0]!.dataset.messageId).toBe("live-001");
    expect(lineOf).toHaveBeenCalledTimes(1);
    // The rows it pushed down are the same rows; the oldest went.
    expect(after.slice(1).every((row, i) => row === before[i])).toBe(true);
    expect(after).toHaveLength(PAGE);
    for (let i = 0; i < PAGE; i++) await says(liveEvent());
    expect(rows()).toHaveLength(PAGE);
    expect(rows()[0]!.dataset.messageId).toBe("live-101");
    expect(within(rail()).getByRole("button", { name: "Show earlier" })).toBeTruthy();
  });

  it("pushes no row out from under someone reading below the top, and goes back to a page once they're back", async () => {
    await dashboard();
    const oldest = ids().at(-1);
    await scrollTo(400);
    for (let i = 0; i < 50; i++) await says(liveEvent());
    expect(rows()).toHaveLength(PAGE + 50);
    expect(ids().at(-1)).toBe(oldest);
    await scrollTo(0);
    expect(rows()).toHaveLength(PAGE);
    expect(ids()[0]).toBe("live-050");
  });

  it("reads one group's part back until it shows, and keeps it while other groups' events come in", async () => {
    await dashboard();
    fireEvent.click(within(rail()).getByRole("radio", { name: "Acme" }));
    await settle();
    const acme = history.filter((e) => e.group === "acme").map((e) => e.id);
    expect(ids()).toEqual(acme);
    expect(within(rail()).queryByText(/Nothing has happened yet/)).toBeNull();
    for (let i = 1; i < PAGE; i++) await says(liveEvent());
    expect(ids()).toEqual(acme);
    await says(liveEvent("acme"));
    expect(ids()).toEqual(["live-100", ...acme]);
  });
});

describe("the times on the Floor's tiles", () => {
  const twoMinutesAgo = new Date(NOW - 2 * 60_000).toISOString();
  /** A session whose background work runs, one that waits on a test, and
   *  an agent at work: none says anything new as the minutes go by. */
  const quiet = async () => {
    await says({ type: "session", session: { ...running(5), state: "done", background: { count: 1, since: twoMinutesAgo } } });
    await says({ type: "session", session: { ...running(6), waits: { words: "Waits on npm test", since: twoMinutesAgo } } });
  };
  const times = () => [
    screen.getByText(/Waiting on .* · \d+m/).textContent,
    screen.getByText(/Waits on npm test, \d+m/).textContent,
    ...(served ? [screen.getByText(/working · \d+ min/).textContent] : []),
  ];

  it.each([
    ["Desk's groups", () => (served = { ...overview, items: [...overview.items, { kind: "agent", id: "scout", name: "Scout", state: "working", since: twoMinutesAgo }] })],
    ["the sessions, before the engine has an overview", () => (served = null)],
  ])("move on with the minutes in %s", async (_, serve) => {
    serve();
    useFloor.setState({ hubs: {} });
    await quiet();
    await dashboard();
    expect(times().every((t) => /\b2 ?m/.test(t!))).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(times().every((t) => /\b7 ?m/.test(t!))).toBe(true);
  });
});
