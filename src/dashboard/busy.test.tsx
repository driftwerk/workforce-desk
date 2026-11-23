import { act, cleanup, render, screen, within } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useFloor } from "../floor/store";
import { agent, at, hub, need, NOW, ready, view } from "../floor/testing";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { ActivityEvent, DeskEvent, Overview, Session } from "../hub/types";
import { lineOf } from "../overview/activity";
import { PAGE, useOverview } from "../overview/store";
import { useUi } from "../shell/ui";
import { FakeSocket } from "../testing/sockets";
import { Dashboard } from "./Dashboard";

// The Dashboard while a dozen sessions run: what arrives unchanged costs
// nothing, a live event touches only its own row, and Activity stays a page.

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));
vi.mock("../overview/activity", async (actual) => {
  const real = await actual<typeof import("../overview/activity")>();
  return { ...real, lineOf: vi.fn(real.lineOf) };
});

const SESSIONS = 12;

const running = (i: number, updatedAt = at(i)): Session =>
  ({ id: `s${i}`, engine: "claude", name: `web-${i}`, goal: `task ${i}`, cwd: "/work", origin: "desk", state: "working", live: true, createdAt: at(120), updatedAt }) as Session;

const event = (id: string, min: number): ActivityEvent => {
  const who = { kind: "session" as const, id: `s${Number(id.replace(/\D/g, "")) % SESSIONS}`, name: "web" };
  return { id, at: at(min), kind: "started", actor: who, subject: who, text: `started ${id}` };
};

const page = Array.from({ length: PAGE }, (_, i) => event(`e${i}`, i + 1));

const overview: Overview = {
  brief: null,
  counts: { working: SESSIONS, needsYou: 0, doneToday: 0 },
  items: Array.from({ length: SESSIONS }, (_, i) => ({ kind: "session", id: `s${i}`, name: `web-${i}`, state: "working", detail: "● Bash npm test" })),
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** How often each of this computer's engine's routes was read. */
let reads: Record<string, number>;

const engine: DeskTransport = {
  fetch: async (method, path) => {
    const route = `${method} ${path.split("?")[0]}`;
    reads[route] = (reads[route] ?? 0) + 1;
    if (route === "GET /api/desk/overview") return json(overview);
    if (route === "GET /api/desk/activity") return json({ events: page, more: true });
    if (route === "GET /api/desk/manager") return json({ agentId: null, level: null });
    return new Response("Not Found", { status: 404 });
  },
  socket: (path) => new FakeSocket(`ws://local.test${path}`) as unknown as DeskSocket,
};

const says = (e: DeskEvent) => act(() => FakeSocket.find("/api/desk/events")!.receive(e));

let commits: number;
let disconnect: () => void;

const rows = () => [...document.querySelectorAll<HTMLElement>(".ev-list [data-message-id]")];

const dashboard = async () => {
  render(
    <Profiler id="dashboard" onRender={() => void (commits += 1)}>
      <Dashboard onNewSession={() => {}} />
    </Profiler>,
  );
  await act(() => vi.advanceTimersByTimeAsync(1000));
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  FakeSocket.reset();
  reads = {};
  commits = 0;
  useUi.setState({ activityOpen: true });
  useChat.setState({ hubs: [hub("local")], roster: [] });
  useFloor.setState({ hubs: { local: ready(view({ needs: [need("question:t1", agent("scout", "Scout"))] })) }, deciding: {}, problems: {}, answered: {} });
  useOverview.setState({ overview: null, overviewSupport: "unknown", activitySupport: "unknown", feeds: {}, manager: null, managerSupport: "unknown" });
  useDesk.setState({ sessions: {}, restore: [], rooms: {}, engines: {}, openId: null, view: "floor" });
  disconnect = useDesk.getState().connect(engine);
  await act(() => vi.advanceTimersByTimeAsync(0));
  await says({ type: "snapshot", sessions: Array.from({ length: SESSIONS }, (_, i) => running(i)), restore: [], rooms: [] });
  vi.mocked(lineOf).mockClear();
});
afterEach(() => {
  disconnect();
  cleanup();
  vi.useRealTimers();
});

describe("the Dashboard with a dozen sessions running", () => {
  it("reads Activity once into its rows and leaves them be while the sessions report in", async () => {
    await dashboard();
    expect(rows()).toHaveLength(PAGE);
    const before = rows();
    const restore = useDesk.getState().restore;
    vi.mocked(lineOf).mockClear();
    // Every session says it's still at it, as the engine's look every ten
    // seconds has each one do.
    for (let i = 0; i < SESSIONS; i++) await says({ type: "session", session: running(i, new Date().toISOString()) });
    expect(lineOf).not.toHaveBeenCalled();
    expect(rows().every((row, i) => row === before[i])).toBe(true);
    expect(useDesk.getState().restore).toBe(restore);
  });

  it("draws nothing again for an overview read again that says the same", async () => {
    await dashboard();
    for (let i = 0; i < SESSIONS; i++) await says({ type: "session", session: running(i, new Date().toISOString()) });
    const shown = useOverview.getState().overview;
    const read = reads["GET /api/desk/overview"]!;
    commits = 0;
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(reads["GET /api/desk/overview"]).toBe(read + 1);
    expect(useOverview.getState().overview).toBe(shown);
    expect(commits).toBe(0);
  });

  it("puts a live event at the top without drawing the rows below it again, and keeps a page", async () => {
    await dashboard();
    const before = rows();
    vi.mocked(lineOf).mockClear();
    await says({ type: "activity", event: event("live-001", 0) });
    const after = rows();
    expect(after[0]!.dataset.messageId).toBe("live-001");
    expect(lineOf).toHaveBeenCalledTimes(1);
    // The rows it pushed down are the same rows; the oldest went.
    expect(after.slice(1).every((row, i) => row === before[i])).toBe(true);
    expect(after).toHaveLength(PAGE);
    for (let i = 2; i <= 500; i++) await says({ type: "activity", event: event(`live-${String(i).padStart(3, "0")}`, 0) });
    expect(rows()).toHaveLength(PAGE);
    expect(rows()[0]!.dataset.messageId).toBe("live-500");
    expect(within(screen.getByRole("complementary", { name: "Activity" })).getByRole("button", { name: "Show earlier" })).toBeTruthy();
  });
});
