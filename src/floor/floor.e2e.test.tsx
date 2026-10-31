import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { deliver, layOut, startGrids, useGrids } from "../grids/store";
import { EMPTY_LAYOUT } from "../groups/model";
import type { DeskHub } from "../hub/client";
import { localIso } from "../hub/floor";
import { useDesk } from "../hub/store";
import type { Overview, Session } from "../hub/types";
import { useOverview } from "../overview/store";
import { useSettings } from "../settings/store";
import { Sidebar } from "../shell/Sidebar";
import { defaultShortcuts } from "../shortcuts/keys";
import { Floor } from "./Floor";
import { SETTLE_MS, TICK_MS, useFloor, watchFloor } from "./store";
import { NOW, agent, approval, at, fakeFetch, fakeHub, hub, need, session, view, work, type FakeHub } from "./testing";
import { clock } from "./time";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));

const MIN = 60_000;
const later = (min: number) => new Date(NOW + min * MIN).toISOString();

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
let stop: () => void;

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  hubs = {
    local: fakeHub({
      floor: view({
        needs: [approval("wait:t1:ap-1", "s1", { who: session("s1", "api-e7"), since: at(12) })],
        working: [],
        lanes: [
          {
            who: session("s1", "api-e7"),
            spans: [
              { kind: "working", from: at(40), to: at(12) },
              { kind: "waiting", from: at(12), to: null },
            ],
          },
        ],
        counts: { working: 0, needsYou: 1, doneToday: 2 },
      }),
      usage: {
        asOf: at(0),
        logins: [],
        readings: [
          {
            kind: "claude",
            where: "mac",
            account: "a",
            plan: "max",
            windows: [{ usedPercent: 80, resetsAt: later(3), minutes: 300 }],
            observedAt: at(1),
          },
        ],
      },
    }),
    b: fakeHub({
      floor: view({
        needs: [
          need("question:t9", agent("scout", "Scout"), { ask: "Main or release?", since: at(30) }),
          need("question:t8", agent("ada", "Ada"), { since: at(20) }),
        ],
        counts: { working: 0, needsYou: 2, doneToday: 0 },
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
  useChat.setState({
    hubs: [hub("local"), hub("b")],
    roster: [
      { hubId: "b", id: "scout", name: "Scout", model: null, provider: null, isDefault: false },
      { hubId: "b", id: "ada", name: "Ada", model: null, provider: null, isDefault: false },
    ],
  });
  stop = watchFloor();
});
afterEach(() => {
  stop();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rail = () => screen.getByRole("complementary", { name: "Activity" });
const needsTab = () => within(rail()).getByRole("radio", { name: /Needs you/ });
const counts = () => screen.getByText(/working ·/).textContent;
/** The items' badges; a group's header sums its own. */
const badges = () => screen.getAllByText(/^\d+ needs? you$/, { selector: ".gi .badge > *" }).map((b) => parseInt(b.textContent!, 10));
const rightNowNeeds = () =>
  within(screen.getByRole("region", { name: "Right now" }))
    .getByRole("group", { name: /^Needs you · / })
    .getAttribute("aria-label");

describe("the Floor across hubs", () => {
  it("counts what needs you the same everywhere, and drops what was answered elsewhere on the next read", async () => {
    await shell();
    expect(counts()).toBe("0 working · 3 need you · 2 done today");
    expect(within(needsTab()).getByText("3")).toBeTruthy();
    expect(rightNowNeeds()).toBe("Needs you · 3");
    expect(badges().reduce((a, b) => a + b, 0)).toBe(3);
    hubs.b!.floor = view({ needs: [need("question:t8", agent("ada", "Ada"), { since: at(20) })], counts: { working: 0, needsYou: 1, doneToday: 0 } });
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(counts()).toBe("0 working · 2 need you · 2 done today");
    expect(within(needsTab()).getByText("2")).toBeTruthy();
    expect(rightNowNeeds()).toBe("Needs you · 2");
    expect(badges().reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("allows from the rail, and says so when another device answered first", async () => {
    await shell();
    fireEvent.click(needsTab());
    hubs.local!.decide = () => 409;
    await act(async () => fireEvent.click(within(rail()).getByRole("button", { name: /^Allow “/ })));
    expect(hubs.local!.decided).toEqual([{ at: { kind: "session", sessionId: "s1", approvalId: "wait:t1:ap-1" }, choice: "allow" }]);
    expect(within(rail()).getByText("Already answered")).toBeTruthy();
    expect(counts()).toBe("0 working · 2 need you · 2 done today");
  });

  it("reads the new day at midnight, and its lanes start again", async () => {
    const midnight = new Date(NOW);
    midnight.setHours(24, 0, 0, 0);
    stop();
    vi.setSystemTime(midnight.getTime() - MIN);
    stop = watchFloor();
    await shell();
    expect(screen.getByRole("group", { name: "api-e7" })).toBeTruthy();
    hubs.local!.floor = view();
    await act(() => vi.advanceTimersByTimeAsync(MIN + SETTLE_MS + 1));
    expect(hubs.local!.days.at(-1)).toBe(localIso(midnight));
    expect(screen.getByText("Nothing has run yet today.")).toBeTruthy();
  });

  it("shows a plan window reset when it resets, without reading again", async () => {
    await shell();
    const claude = screen.getByRole("region", { name: "Claude plan usage" });
    expect(within(claude).getByText("80%")).toBeTruthy();
    hubs.local!.down = true;
    await act(() => vi.advanceTimersByTimeAsync(3 * MIN + 100));
    expect(within(claude).getByText("0%")).toBeTruthy();
    expect(within(claude).getByText(`Reset at ${clock(later(3))} · no use seen since.`)).toBeTruthy();
  });

  it("shows eight of twenty sessions' lanes", async () => {
    hubs.local!.floor = view({
      lanes: Array.from({ length: 20 }, (_, i) => ({
        who: session(`x${i}`, `s-${i}`),
        spans: [{ kind: "working" as const, from: at(100 - i), to: at(50 - i) }],
      })),
    });
    await shell();
    const today = screen.getByRole("region", { name: "Today" });
    expect(within(today).getAllByRole("group")).toHaveLength(8);
    expect(within(today).getByRole("button", { name: "Show 12 more" })).toBeTruthy();
  });

  it("marks an unreachable hub's needs and holds their actions until it's back", async () => {
    await shell();
    fireEvent.click(needsTab());
    hubs.b!.down = true;
    await act(() => vi.advanceTimersByTimeAsync(TICK_MS + SETTLE_MS));
    const reply = within(rail()).getAllByRole("button", { name: /^Reply to / });
    expect(reply.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(reply[0]!.title).toMatch(/^Hub b unreachable since /);
    expect(counts()).toBe("0 working · 3 need you · 2 done today");
    hubs.b!.down = false;
    await act(() => vi.advanceTimersByTimeAsync(TICK_MS + SETTLE_MS));
    expect(
      within(rail())
        .getAllByRole("button", { name: /^Reply to / })
        .every((b) => !(b as HTMLButtonElement).disabled),
    ).toBe(true);
  });
});

describe("what's happening, beside what's in a grid", () => {
  const happeningRow = (name: string) =>
    within(screen.getByRole("group", { name: "What’s happening" }))
      .getAllByRole("button")
      .find((b) => b.querySelector("b")?.textContent === name)!;
  const sidebarRow = (name: string) =>
    screen.getAllByRole("button").find((b) => b.dataset.item && b.querySelector(".gi-name")?.textContent === name)!;

  beforeEach(() => {
    hubs.local!.floor = { ...hubs.local!.floor!, working: [work(session("s1", "api-e7"), { since: at(5) })] };
    hubs.b!.floor = { ...hubs.b!.floor!, working: [work(agent("scout", "Scout"), { since: at(4) })] };
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    deliver(MAIN_GRID, { kind: "agent", agent: "b/scout" });
    useChat.setState({ panelAgent: null });
  });

  it("opens a session that's in a grid in its card beside the Floor, and stays on the Floor", async () => {
    await shell();
    fireEvent.click(happeningRow("api-e7"));
    expect(useDesk.getState().view).toBe("floor");
    expect(useDesk.getState().openId).toBe("s1");
    expect(useGrids.getState().flash).toBeNull();
  });

  it("opens an agent that's in a grid in its DM beside the Floor, and stays on the Floor", async () => {
    await shell();
    fireEvent.click(happeningRow("Scout"));
    expect(useDesk.getState().view).toBe("floor");
    expect(useChat.getState().panelAgent).toBe("b/scout");
    expect(useGrids.getState().flash).toBeNull();
  });

  it("leaves the sidebar taking the person to the grid", async () => {
    await shell();
    fireEvent.click(sidebarRow("api-e7"));
    expect(useDesk.getState().view).toBe("grids");
    expect(useDesk.getState().openId).toBeNull();
    useDesk.setState({ view: "floor" });
    fireEvent.click(sidebarRow("Scout"));
    expect(useDesk.getState().view).toBe("grids");
    expect(useChat.getState().panelAgent).toBeNull();
  });
});
