import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { startGrids, useGrids } from "../grids/store";
import { EMPTY_LAYOUT } from "../groups/model";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { DeskEvent, Overview, Session } from "../hub/types";
import { useOverview } from "../overview/store";
import { useSettings } from "../settings/store";
import { Sidebar } from "../shell/Sidebar";
import { defaultShortcuts } from "../shortcuts/keys";
import { FakeSocket } from "../testing/sockets";
import { Floor } from "./Floor";
import { SETTLE_MS, TICK_MS, useFloor, watchFloor } from "./store";
import { NOW, approval, at, fakeFetch, fakeHub, hub, session, view, work, type FakeHub } from "./testing";

// The Floor with two engines: this computer's and a machine's (devbox),
// each a fake hub of its own, the machine's sessions on its own engine.

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));

const live = (id: string, name: string, more: Partial<Session> = {}): Session =>
  ({
    id,
    name,
    engine: "claude",
    goal: "",
    cwd: "/work",
    state: "blocked",
    live: true,
    origin: "desk",
    pending: null,
    updatedAt: at(1),
    createdAt: at(60),
    ...more,
  }) as Session;

const overview: Overview = { brief: null, counts: { working: 0, needsYou: 0, doneToday: 0 }, items: [] };

let hubs: Record<string, FakeHub>;
let stops: (() => void)[];
/** What devbox's engine was asked, as `METHOD path`. */
let asked: string[];

/** devbox's engine as its transport reaches it: its events socket, and its
 *  admin routes. */
const devboxEngine = (): DeskTransport => ({
  fetch: async (method, path) => {
    asked.push(`${method} ${path}`);
    if (method === "POST" && path.startsWith("/api/desk/sessions/s1/asked/"))
      return new Response(JSON.stringify(live("s1", "web-d2", { state: "working" })), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
  },
  socket: (path) => new FakeSocket(`ws://devbox.test${path}`) as unknown as DeskSocket,
});

const devboxSays = (e: DeskEvent) => FakeSocket.find("/api/desk/events")!.receive(e);

const kept = new Map<string, unknown>();
const memory = (): GridStorage =>
  ({
    get: (k) => kept.get(k),
    set: (k, v) => void kept.set(k, structuredClone(v)),
    remove: (k) => void kept.delete(k),
    subscribe: () => () => {},
  }) as GridStorage;

const settle = () => act(() => vi.advanceTimersByTimeAsync(SETTLE_MS + 1));

const shell = async () => {
  render(
    <>
      <Sidebar onAsk={() => {}} onNewSession={() => {}} onNewRoom={() => {}} onNewCrew={() => {}} onSettings={() => {}} />
      <Floor onNewSession={() => {}} />
    </>,
  );
  await settle();
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  FakeSocket.reset();
  asked = [];
  hubs = {
    local: fakeHub({
      floor: view({
        needs: [approval("wait:t1:ap-1", "s1", { who: session("s1", "api-e7"), since: at(12) })],
        counts: { working: 0, needsYou: 1, doneToday: 0 },
      }),
    }),
    devbox: fakeHub({
      floor: view({
        needs: [approval("wait:t4:ap-9", "s1", { who: session("s1", "web-d2"), since: at(8), ask: "Run cargo build?" })],
        working: [work(session("s2", "worker-b4"), { since: at(6) })],
        counts: { working: 1, needsYou: 1, doneToday: 3 },
      }),
    }),
  };
  vi.stubGlobal("fetch", fakeFetch(hubs));
  kept.clear();
  useSettings.setState({ loaded: true, shortcuts: {}, keys: defaultShortcuts(), groups: [], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  useDesk.setState({
    view: "floor",
    rooms: {},
    sessions: { s1: live("s1", "api-e7") },
    engines: {},
    openId: null,
    hub: {
      overview: vi.fn(() => Promise.resolve(overview)),
      manager: vi.fn(() => Promise.resolve({ agentId: null, level: null })),
      activity: vi.fn(() => Promise.resolve({ events: [], more: false })),
      suggestions: vi.fn(() => Promise.resolve([])),
    } as unknown as DeskHub,
  });
  useOverview.setState({ overview: null, overviewSupport: "unknown", activitySupport: "unknown", feeds: {}, manager: null });
  useFloor.setState({ hubs: {}, deciding: {}, problems: {}, answered: {} });
  // devbox's engine is a hub account too, read with its device token for the Floor.
  useChat.setState({ hubs: [hub("local"), hub("devbox", { label: "devbox", machine: "devbox" })], roster: [] });
  stops = [useDesk.getState().connectMachine("devbox", devboxEngine()), watchFloor()];
  await act(async () => {
    await Promise.resolve();
  });
  devboxSays({ type: "snapshot", sessions: [live("s1", "web-d2"), live("s2", "worker-b4", { state: "working" })], restore: [], rooms: [] });
});
afterEach(async () => {
  // What a test left to read once things settle is read (the Floor's reads
  // wait on a timer of their own, which must not outlive the test's clock).
  await settle();
  stops.forEach((s) => s());
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rail = () => screen.getByRole("complementary", { name: "Activity" });
const needsTab = () => within(rail()).getByRole("radio", { name: /Needs you/ });
const counts = () => document.querySelector(".crew-floor-counts")?.textContent;
const sidebarNames = () => [...document.querySelectorAll("[data-item] .gi-name")].map((n) => n.textContent);
const needRow = (name: string) =>
  within(rail())
    .getAllByRole("button")
    .find((b) => b.querySelector("b")?.textContent === name)!;

describe("the Floor with a machine's engine", () => {
  it("sums what needs you over both engines, and keeps the machine's sessions out of this computer's groups", async () => {
    await shell();
    expect(counts()).toBe("1 working · 2 need you · 3 done today");
    expect(within(needsTab()).getByText("2")).toBeTruthy();
    // The same session id on each engine is two sessions.
    expect(Object.keys(useDesk.getState().sessions).sort()).toEqual(["devbox/s1", "devbox/s2", "s1"]);
    expect(sidebarNames()).toContain("api-e7");
    expect(sidebarNames()).not.toContain("web-d2");
    expect(sidebarNames()).not.toContain("worker-b4");
  });

  it("opens the machine's session, not this computer's with the same id", async () => {
    await shell();
    fireEvent.click(needsTab());
    fireEvent.click(needRow("web-d2"));
    expect(useDesk.getState().openId).toBe("devbox/s1");
    fireEvent.click(needRow("api-e7"));
    expect(useDesk.getState().openId).toBe("s1");
  });

  it("allows on the machine's own floor, and this computer's on its own", async () => {
    await shell();
    fireEvent.click(needsTab());
    await act(async () => fireEvent.click(within(rail()).getByRole("button", { name: /^Allow “Run cargo build\?” / })));
    expect(hubs.devbox!.decided).toEqual([{ at: { kind: "session", sessionId: "s1", approvalId: "wait:t4:ap-9" }, choice: "allow" }]);
    expect(hubs.local!.decided).toEqual([]);
    await act(async () => fireEvent.click(within(rail()).getByRole("button", { name: /^Allow “Run npm test\?” / })));
    expect(hubs.local!.decided).toHaveLength(1);
  });

  it("answers an asked session on the machine through the machine's engine, never this computer's", async () => {
    const refused = {
      ask: "Stopped: Bash was not allowed",
      why: "auto mode refused Bash",
      options: null,
      denied: { tool: "Bash(rm -rf build)", detail: "rm -rf build", reason: "[Destructive]", allowable: true },
    };
    hubs.devbox!.floor = view({
      needs: [{ ...approval("asked:s1", "s1", { who: session("s1", "web-d2"), since: at(3), ask: refused.ask }), kind: "question", answer: { kind: "reply" } }],
      counts: { working: 0, needsYou: 1, doneToday: 0 },
    });
    devboxSays({ type: "session", session: live("s1", "web-d2", { state: "asking", asked: refused }) });
    const dismissAsked = vi.fn(() => Promise.resolve(live("s1", "api-e7")));
    useDesk.setState((d) => ({ hub: { ...d.hub, dismissAsked } as unknown as DeskHub }));
    await shell();
    fireEvent.click(needsTab());
    await act(async () => fireEvent.click(within(rail()).getByRole("button", { name: "Allow this command for this session and continue: web-d2" })));
    expect(asked).toContain("POST /api/desk/sessions/s1/asked/allow");
    expect(dismissAsked).not.toHaveBeenCalled();
  });

  it("marks the machine's needs stale while it can't be reached, and leaves this computer's be", async () => {
    await shell();
    fireEvent.click(needsTab());
    hubs.devbox!.down = true;
    await act(() => vi.advanceTimersByTimeAsync(TICK_MS + SETTLE_MS));
    const allows = within(rail()).getAllByRole("button", { name: /^Allow “/ }) as HTMLButtonElement[];
    const theirs = allows.find((b) => b.getAttribute("aria-label")!.includes("cargo build"))!;
    const mine = allows.find((b) => b.getAttribute("aria-label")!.includes("npm test"))!;
    expect(theirs.disabled).toBe(true);
    expect(theirs.title).toMatch(/^devbox unreachable since /);
    expect(mine.disabled).toBe(false);
    expect(counts()).toBe("1 working · 2 need you · 3 done today");
  });

  it("lets the machine's sessions go with its engine", async () => {
    await shell();
    stops.shift()!();
    expect(Object.keys(useDesk.getState().sessions)).toEqual(["s1"]);
  });
});
