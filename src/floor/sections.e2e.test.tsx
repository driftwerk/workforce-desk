// The Floor by group, end to end against fake hubs: this computer's hub
// names Sarah as Acme's boss and Mia as Globex's, seals Old work and stamps
// its own items; another hub (b) and a machine (devbox) say things of groups
// and bosses that are theirs alone, and are placed by the sidebar instead.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { startGrids, useGrids } from "../grids/store";
import { useHubLayout } from "../groups/hubLayout";
import { EMPTY_LAYOUT, type Layout } from "../groups/model";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { BossView, FloorView, Overview, Session } from "../hub/types";
import { useOverview } from "../overview/store";
import { useSettings } from "../settings/store";
import { useUi } from "../shell/ui";
import { defaultShortcuts } from "../shortcuts/keys";
import { Floor } from "./Floor";
import { useFolded } from "./FloorSection";
import { SETTLE_MS, useFloor, watchFloor } from "./store";
import { NOW, agent, approval, at, fakeFetch, fakeHub, hub, need, session, view, work, type FakeHub } from "./testing";

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
  ({ id, name, engine: "claude", goal: "", cwd: "/work", state: "working", live: true, origin: "desk", pending: null, updatedAt: at(1), createdAt: at(60), ...more }) as Session;

const layout: Layout = {
  groups: [
    { id: "acme", name: "Acme", collapsed: false, items: ["agent:local/sarah", "session:s-web", "agent:b/scout", "session:devbox/m1"] },
    { id: "globex", name: "Globex", collapsed: false, items: ["agent:local/mia", "session:s-idx"] },
    { id: "personal", name: "Personal", collapsed: false, items: ["session:s-dot"] },
    { id: "old", name: "Old work", collapsed: false, items: ["session:s-old"] },
  ],
  ungrouped: { collapsed: false, items: ["agent:local/desk", "agent:b/ada"] },
};

const boss = (agentId: string, name: string, group: string | null): BossView => ({
  scope: group ? { kind: "group", group } : { kind: "ungrouped" },
  agent: agentId,
  name,
  level: "act",
  state: "idle",
});

/** This computer's hub, as BH17 sends it to the person who holds its Desk. */
const localFloor = (): FloorView =>
  view({
    needs: [
      approval("wait:t1:ap-1", "s-web", { who: session("s-web", "acme-web"), ask: "Run git push --force?", why: "Sarah can’t answer this one: it rewrites history.", since: at(30), group: "acme", boss: "sarah" }),
      need("question:t2", session("s-dot", "dotfiles"), { ask: "Remove the backup folder?", since: at(20), group: "personal" }),
      need("question:t3", session("s-old", "old-site"), { ask: "Which branch?", since: at(4), group: "old" }),
    ],
    working: [
      work(session("s-web", "acme-web"), { since: at(9), group: "acme", boss: "sarah" }),
      work(session("s-idx", "globex-indexer"), { since: at(7), group: "globex", boss: "mia" }),
    ],
    done: [work(session("s-idx", "globex-indexer"), { since: at(90), endedAt: at(50), outcome: "finished", group: "globex", boss: "mia" })],
    counts: { working: 2, needsYou: 3, doneToday: 1 },
    bosses: [boss("desk", "Desk", null), { ...boss("sarah", "Sarah", "acme"), state: "working" }, boss("mia", "Mia", "globex")],
    sealed: ["old"],
    plans: [
      {
        id: "p1",
        goal: "Checkout v2",
        group: "acme",
        boss: "sarah",
        bossName: "Sarah",
        state: "running",
        progress: { done: 3, doing: 3, review: 0, ready: 1, blocked: 1, waiting: 0, total: 8, next: ["ACM-16"] },
      },
    ],
  });

/** Hub b: its own word on groups and bosses, which this Desk never reads. */
const bFloor = (): FloorView =>
  view({
    needs: [
      need("question:t9", agent("scout", "Scout"), { ask: "Main or release?", since: at(40), group: "globex", boss: "mia" }),
      need("question:t8", agent("ada", "Ada"), { since: at(10), group: "acme", boss: "sarah" }),
    ],
    counts: { working: 0, needsYou: 2, doneToday: 0 },
    bosses: [boss("zed", "Zed", "globex")],
    sealed: ["acme"],
  });

/** devbox's engine: a machine's session, `session:devbox/m1` on the sidebar. */
const devboxFloor = (): FloorView =>
  view({
    needs: [approval("wait:t4:ap-9", "m1", { who: session("m1", "acme-worker"), ask: "Run cargo build?", since: at(15), group: "globex" })],
    counts: { working: 0, needsYou: 1, doneToday: 0 },
  });

const overview: Overview = { brief: null, counts: { working: 0, needsYou: 0, doneToday: 0 }, items: [] };

let hubs: Record<string, FakeHub>;
let stop: () => void;

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

const settle = () => act(() => vi.advanceTimersByTimeAsync(SETTLE_MS + 1));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  hubs = { local: fakeHub({ floor: localFloor() }), b: fakeHub({ floor: bFloor() }), devbox: fakeHub({ floor: devboxFloor() }) };
  vi.stubGlobal("fetch", fakeFetch(hubs));
  useSettings.setState({ loaded: true, shortcuts: {}, keys: defaultShortcuts(), groups: [], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
  useFolded.setState({ folded: {} });
  useUi.setState({ activityOpen: true });
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  useDesk.setState({
    view: "floor",
    rooms: {},
    sessions: { "s-web": live("s-web", "acme-web"), "s-dot": live("s-dot", "dotfiles"), "s-old": live("s-old", "old-site"), "s-idx": live("s-idx", "globex-indexer") },
    openId: null,
    hub: {
      overview: vi.fn(() => Promise.resolve(overview)),
      manager: vi.fn(() => Promise.resolve({ agentId: "desk", level: "act" })),
      activity: vi.fn(() => Promise.resolve({ events: [], more: false })),
      suggestions: vi.fn(() => Promise.resolve([])),
    } as unknown as DeskHub,
  });
  // After the hub: a new hub starts from Desk's own layout until its snapshot.
  useHubLayout.setState({ layout, kept: true });
  useOverview.setState({ overview: null, overviewSupport: "unknown", activitySupport: "unknown", feeds: {}, manager: null });
  useFloor.setState({ hubs: {}, deciding: {}, problems: {}, answered: {} });
  useChat.setState({
    panelAgent: null,
    hubs: [hub("local"), hub("b"), hub("devbox", { label: "devbox", machine: "devbox" })],
    roster: [
      { hubId: "local", id: "desk", name: "Desk", model: null, provider: null, isDefault: true },
      { hubId: "local", id: "sarah", name: "Sarah", model: null, provider: null, isDefault: false },
      { hubId: "local", id: "mia", name: "Mia", model: null, provider: null, isDefault: false },
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
  useHubLayout.setState({ layout: null, kept: null });
});

const floor = async () => {
  render(<Floor onNewSession={() => {}} />);
  await settle();
};

const sections = () => screen.getAllByRole("region").filter((r) => r.classList.contains("fsec"));
const section = (name: string) => screen.getByRole("region", { name });
const needsIn = (name: string) =>
  within(section(name))
    .queryAllByRole("listitem")
    .map((li) => li.querySelector(".floor-item-head b")?.textContent);
const rail = () => screen.getByRole("complementary", { name: "Activity" });
const counts = () => document.querySelector(".crew-floor-counts")!.textContent;

describe("the Floor by group, across hubs", () => {
  it("is in sections, needs first, the oldest first, with the main boss's last of the rest", async () => {
    await floor();
    // Needs: b's Scout 40 min (Acme, by the sidebar), Acme's push 30, dotfiles
    // 20 (main), devbox 15 (Acme), Ada 10 (main), Old work 4 (sealed). Globex
    // has none: after them, in sidebar order.
    expect(sections().map((s) => s.getAttribute("aria-label"))).toEqual(["Acme", "Everything else, Desk runs it", "Old work", "Globex"]);
    expect(needsIn("Acme")).toEqual(["Scout", "acme-web", "acme-worker"]);
    expect(needsIn("Everything else, Desk runs it")).toEqual(["dotfiles", "Ada"]);
    expect(needsIn("Old work")).toEqual(["old-site"]);
    expect(within(section("Globex")).queryByRole("group", { name: /^Needs you/ })).toBeNull();
  });

  it("counts the same total in the header, the jump bar, the sections and Activity, each need once", async () => {
    await floor();
    expect(counts()).toBe("2 working · 6 need you · 1 done today");
    const jump = screen.getByRole("navigation", { name: "Needs you, by group" });
    expect(within(jump).getAllByRole("button").map((b) => b.textContent)).toEqual(["Acme 3", "Desk 2", "Old work 1"]);
    const summed = sections().reduce((n, s) => n + within(s).queryAllByRole("listitem").length, 0);
    expect(summed).toBe(6);
    // Right now no longer lists them: the sections do.
    expect(within(screen.getByRole("region", { name: "Right now" })).queryByRole("group", { name: /^Needs you/ })).toBeNull();
    expect(within(within(rail()).getByRole("radio", { name: /Needs you/ })).getByText("6")).toBeTruthy();
  });

  it("shows each boss at its section's head, with its plan and its sessions, and messages it", async () => {
    await floor();
    const acme = section("Acme");
    expect(within(acme).getByText(/^Sarah runs it/).textContent).toBe("Sarah runs it · working · Act");
    expect(within(acme).getByRole("group", { name: "Plan: Checkout v2" }).textContent).toContain("3 of 8 done · 3 running · next ACM-16");
    expect(within(acme).getByRole("article", { name: "acme-web" })).toBeTruthy();
    expect(within(section("Globex")).getByRole("article", { name: "globex-indexer" })).toBeTruthy();
    expect(within(section("Globex")).getByRole("button", { name: "Done today · 1" })).toBeTruthy();
    expect(within(section("Old work")).getByText("No one oversees it now · what it asks comes to you")).toBeTruthy();
    fireEvent.click(within(acme).getByRole("button", { name: "Message Sarah" }));
    expect(useChat.getState().panelAgent).toBe("local/sarah");
  });

  it("keeps a collapsed section's needs in view, and answers one there", async () => {
    await floor();
    fireEvent.click(within(section("Acme")).getByRole("button", { name: "Collapse Acme" }));
    expect(needsIn("Acme")).toEqual(["Scout", "acme-web", "acme-worker"]);
    expect(within(section("Acme")).queryByRole("article")).toBeNull();
    await act(async () => fireEvent.click(within(section("Acme")).getByRole("button", { name: /^Allow “Run git push --force\?”/ })));
    expect(hubs.local!.decided).toEqual([{ at: { kind: "session", sessionId: "s-web", approvalId: "wait:t1:ap-1" }, choice: "allow" }]);
    hubs.local!.floor = { ...localFloor(), needs: localFloor().needs.slice(1), counts: { working: 2, needsYou: 2, doneToday: 1 } };
    await settle();
    expect(needsIn("Acme")).toEqual(["Scout", "acme-worker"]);
    expect(counts()).toBe("2 working · 5 need you · 1 done today");
  });

  it("filters Activity to one group's needs", async () => {
    await floor();
    fireEvent.click(within(rail()).getByRole("radio", { name: /Needs you/ }));
    const groups = within(rail()).getByRole("radiogroup", { name: "Group" });
    expect(within(groups).getAllByRole("radio").map((r) => r.textContent)).toEqual(["All groups", "Acme", "Desk", "Old work", "Globex"]);
    const listed = () => within(within(rail()).getByRole("list", { name: "Still waiting on you" })).getAllByRole("listitem").length;
    expect(listed()).toBe(6);
    fireEvent.click(within(groups).getByRole("radio", { name: "Acme" }));
    expect(listed()).toBe(3);
    fireEvent.click(within(groups).getByRole("radio", { name: "Old work" }));
    expect(listed()).toBe(1);
    // The tab still counts every need.
    expect(within(within(rail()).getByRole("radio", { name: /Needs you/ })).getByText("6")).toBeTruthy();
  });

  it("is flat as before once no group has a boss, though the main boss is named", async () => {
    hubs.local!.floor = { ...localFloor(), bosses: [boss("desk", "Desk", null)], plans: [] };
    await floor();
    expect(sections()).toHaveLength(0);
    expect(screen.queryByRole("navigation", { name: "Needs you, by group" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Right now" })).getByRole("group", { name: "Needs you · 6" })).toBeTruthy();
    expect(within(rail()).queryByRole("radiogroup", { name: "Group" })).toBeNull();
  });
});
