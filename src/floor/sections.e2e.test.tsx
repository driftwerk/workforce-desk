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
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { ActivityEvent, BossView, DeskEvent, FloorView, Overview, Session } from "../hub/types";
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** This computer's hub as Desk's own client reaches it: the sidebar's
 *  layout, who oversees what, the overview, and its events. Its floor is read
 *  as every hub's is, through `fakeFetch`. */
class Transport implements DeskTransport {
  events: Socket | null = null;
  layout: Layout = structuredClone(layout);
  activity: ActivityEvent[] = [];
  sessions = [live("s-web", "acme-web"), live("s-dot", "dotfiles"), live("s-old", "old-site"), live("s-idx", "globex-indexer")];
  fetch = async (method: string, path: string): Promise<Response> => {
    const route = `${method} ${path.split("?")[0]}`;
    if (route === "GET /api/desk/manager")
      return json({ agentId: "desk", level: "act", bosses: [{ agentId: "sarah", name: "Sarah", group: "acme", level: "act" }, { agentId: "mia", name: "Mia", group: "globex", level: "act" }], sealed: ["old"] });
    if (route === "GET /api/desk/sessions") return json(this.sessions);
    if (route === "GET /api/desk/layout") return json(this.layout);
    if (route === "GET /api/desk/overview") return json(overview);
    if (route === "GET /api/desk/activity") return json({ events: this.activity, more: false });
    if (route === "GET /api/desk/suggestions") return json({ suggestions: [] });
    return new Response("Not Found", { status: 404 });
  };
  socket = (path: string): DeskSocket => {
    const s = new Socket();
    if (path === "/api/desk/events") this.events = s;
    return s;
  };
}

let hubs: Record<string, FakeHub>;
let transport: Transport;
let stop: () => void;
let disconnect: (() => void) | undefined;

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
  transport = new Transport();
  useSettings.setState({ loaded: true, layoutOnHub: true, shortcuts: {}, keys: defaultShortcuts(), groups: [], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
  useFolded.setState({ folded: {} });
  useUi.setState({ activityOpen: true });
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  useDesk.setState({ view: "floor", rooms: {}, sessions: {}, openId: null });
  useOverview.setState({ overview: null, overviewSupport: "unknown", activitySupport: "unknown", feeds: {}, manager: null, suggestions: {}, suggestionsLoaded: true });
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
  disconnect?.();
  disconnect = undefined;
  stop();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Desk connected to this computer's hub, its snapshot (with the sidebar's
 *  layout) in, and the Floor shown. */
const floor = async () => {
  disconnect = useDesk.getState().connect(transport);
  await act(async () => {
    await Promise.resolve();
    transport.events!.say({ type: "snapshot", sessions: transport.sessions, restore: [], rooms: [], layout: transport.layout } as DeskEvent);
  });
  expect(useHubLayout.getState().layout).toEqual(transport.layout);
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
    expect(sections().map((s) => s.getAttribute("aria-label"))).toEqual(["Acme", "Desk, everything else", "Old work", "Globex"]);
    expect(needsIn("Acme")).toEqual(["Scout", "acme-web", "acme-worker"]);
    expect(needsIn("Desk, everything else")).toEqual(["dotfiles", "Ada"]);
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

  it("shows a session where it is moved to: the hub's new layout, then its floor stamped anew", async () => {
    await floor();
    expect(needsIn("Acme")).toContain("acme-web");
    const moved: Layout = {
      ...transport.layout,
      groups: transport.layout.groups.map((g) =>
        g.id === "acme" ? { ...g, items: g.items.filter((k) => k !== "session:s-web") } : g.id === "globex" ? { ...g, items: [...g.items, "session:s-web"] } : g,
      ),
    };
    transport.layout = moved;
    const f = localFloor();
    hubs.local!.floor = {
      ...f,
      needs: f.needs.map((n) => (n.who.id === "s-web" ? { ...n, group: "globex", boss: "mia" } : n)),
      working: f.working.map((w) => (w.who.id === "s-web" ? { ...w, group: "globex", boss: "mia" } : w)),
    };
    await act(async () => transport.events!.say({ type: "layout", layout: moved }));
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(needsIn("Acme")).not.toContain("acme-web");
    expect(needsIn("Globex")).toEqual(["acme-web"]);
    expect(within(section("Globex")).getByRole("article", { name: "acme-web" })).toBeTruthy();
    expect(within(section("Acme")).queryByRole("article", { name: "acme-web" })).toBeNull();
  });

  it("keeps a session Desk shows blocked, with nothing asked on any hub, in its group, counted there and in the header", async () => {
    transport.sessions = [...transport.sessions, live("s-api", "acme-api", { state: "blocked" })];
    transport.layout = { ...transport.layout, groups: transport.layout.groups.map((g) => (g.id === "acme" ? { ...g, items: [...g.items, "session:s-api"] } : g)) };
    await floor();
    const tile = within(section("Acme")).getByRole("article", { name: "acme-api" });
    expect(within(tile).getByText("Blocked, nothing asked")).toBeTruthy();
    expect(within(section("Acme")).getByText("Working · 2")).toBeTruthy();
    // The header counts what the sections show.
    expect(counts()).toBe("3 working · 6 need you · 1 done today");
    const shown = sections().reduce((n, s) => n + Number(/Working · (\d+)/.exec(s.textContent ?? "")?.[1] ?? 0), 0);
    expect(shown).toBe(3);
  });

  it("filters Activity by the group each event happened in, so a moved session's past stays there", async () => {
    const ev = (id: string, group: string | null | undefined, min: number): ActivityEvent => ({
      id,
      at: at(min),
      kind: "finished",
      actor: { kind: "session", id: "s-web", name: "acme-web" },
      subject: { kind: "session", id: "s-web", name: "acme-web" },
      text: `finished ${id}`,
      ...(group === undefined ? {} : { group }),
    });
    // acme-web is in Acme now; it ran in Globex before it moved.
    transport.activity = [ev("e3", "acme", 1), ev("e2", "globex", 50), ev("e1", null, 90)];
    await floor();
    const groups = within(rail()).getByRole("radiogroup", { name: "Group" });
    const shown = () => within(rail()).queryAllByText(/^finished e\d$/).map((e) => e.textContent);
    expect(shown()).toEqual(["finished e3", "finished e2", "finished e1"]);
    fireEvent.click(within(groups).getByRole("radio", { name: "Acme" }));
    expect(shown()).toEqual(["finished e3"]);
    fireEvent.click(within(groups).getByRole("radio", { name: "Globex" }));
    expect(shown()).toEqual(["finished e2"]);
    fireEvent.click(within(groups).getByRole("radio", { name: "Desk" }));
    expect(shown()).toEqual(["finished e1"]);
  });
});
