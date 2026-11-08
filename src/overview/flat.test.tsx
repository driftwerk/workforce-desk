// The Floor with no bossed group is the Floor as it was before groups had
// sections: drawn the same, to the character. The snapshot was taken before
// sections were built; a hub that says only the main boss, and stamps an item
// with a group that has no boss of its own, draws it the same again.

import { act, cleanup, render } from "@testing-library/react";
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
import type { ActivityPage, FloorView, Overview, Session } from "../hub/types";
import { Floor } from "../floor/Floor";
import { SETTLE_MS, useFloor, watchFloor } from "../floor/store";
import { NOW, agent, approval, at, fakeFetch, fakeHub, hub, need, session, view, work, type FakeHub } from "../floor/testing";
import { useSettings } from "../settings/store";
import { defaultShortcuts } from "../shortcuts/keys";
import { useUi } from "../shell/ui";
import { useOverview } from "./store";

// Times are said in the computer's zone; the snapshot is in one.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = "UTC";

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
    state: "working",
    live: true,
    origin: "desk",
    pending: null,
    updatedAt: at(1),
    createdAt: at(60),
    ...more,
  }) as Session;

const overview: Overview = {
  brief: { text: "Two things need you.", at: at(1), by: { id: "desk", name: "Desk" } },
  counts: { working: 1, needsYou: 2, doneToday: 1 },
  items: [
    { kind: "agent", id: "scout", name: "Scout", state: "needs_you", task: "Preparing the staging deploy", since: at(3) },
    { kind: "agent", id: "ledger", name: "Ledger", state: "working", task: "Comparing spend", detail: "● cost_explorer", since: at(2) },
  ],
};

const page: ActivityPage = {
  events: [{ id: "e1", at: at(3), kind: "question", actor: { kind: "agent", id: "scout", name: "Scout" }, subject: { kind: "agent", id: "scout", name: "Scout" }, text: "asked which branch to deploy" }],
  more: false,
};

const layout: Layout = {
  groups: [{ id: "personal", name: "Personal", collapsed: false, items: ["session:s1", "agent:local/scout"] }],
  ungrouped: { collapsed: false, items: [] },
};

/** Today's floor: a session's request and an agent's question, work running
 *  and done. */
const plain = (): FloorView =>
  view({
    needs: [approval("wait:t1:ap-1", "s1", { who: session("s1", "acme-web"), since: at(12) }), need("question:t9", agent("scout", "Scout"), { ask: "Main or release?", since: at(3) })],
    working: [work(session("s2", "acme-api"), { since: at(8), gist: { purpose: "Payments", now: "Adding refunds.", at: at(2) } }), work(agent("ledger", "Ledger"), { since: at(2) })],
    done: [work(session("s3", "acme-docs"), { since: at(90), endedAt: at(40), outcome: "finished" })],
    counts: { working: 2, needsYou: 2, doneToday: 1 },
  });

/** The same floor from a hub that knows groups: it names the main boss, and
 *  stamps what sits in Personal (no boss of its own) with its group. */
const stamped = (): FloorView => {
  const v = plain();
  const personal = { group: "personal" };
  return {
    ...v,
    needs: v.needs.map((n) => ({ ...n, ...personal })),
    working: v.working.map((w) => (w.who.id === "s2" ? w : { ...w, ...personal })),
    bosses: [{ scope: { kind: "ungrouped" }, agent: "desk", name: "Desk", level: "act", state: "idle" }],
  } as FloorView;
};

let hubs: Record<string, FakeHub>;
let stop: () => void;

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return {
    get: (k) => kept.get(k),
    set: (k, v) => void kept.set(k, structuredClone(v)),
    remove: (k) => void kept.delete(k),
    subscribe: () => () => {},
  } as GridStorage;
};

const drawn = async (floor: FloorView): Promise<string> => {
  hubs = { local: fakeHub({ floor }) };
  vi.stubGlobal("fetch", fakeFetch(hubs));
  useFloor.setState({ hubs: {}, deciding: {}, problems: {}, answered: {} });
  stop = watchFloor();
  const { container } = render(<Floor onNewSession={() => {}} />);
  await act(() => vi.advanceTimersByTimeAsync(SETTLE_MS + 1));
  // Times as the computer's locale writes them ("16:41", "4:41 PM"), as one.
  const html = container.innerHTML.replace(/\b\d{1,2}:\d{2}(?:\s?[AP]M)?/g, "hh:mm");
  stop();
  cleanup();
  return html;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  useSettings.setState({ loaded: true, shortcuts: {}, keys: defaultShortcuts(), groups: [], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  useUi.setState({ activityOpen: true });
  useDesk.setState({
    view: "floor",
    rooms: {},
    sessions: { s1: live("s1", "acme-web", { state: "blocked" }), s2: live("s2", "acme-api") },
    openId: null,
    hub: {
      overview: vi.fn(() => Promise.resolve(overview)),
      manager: vi.fn(() => Promise.resolve({ agentId: "desk", level: "act", bosses: [], sealed: [] })),
      activity: vi.fn(() => Promise.resolve(structuredClone(page))),
      suggestions: vi.fn(() => Promise.resolve([])),
    } as unknown as DeskHub,
  });
  // After the hub: a new hub starts from Desk's own layout until its snapshot.
  useHubLayout.setState({ layout, kept: true });
  useOverview.setState({ overview: null, overviewSupport: "unknown", activitySupport: "unknown", feeds: {}, manager: null });
  useChat.setState({
    hubs: [hub("local")],
    roster: [
      { hubId: "local", id: "desk", name: "Desk", model: null, provider: null, isDefault: true },
      { hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false },
      { hubId: "local", id: "ledger", name: "Ledger", model: null, provider: null, isDefault: false },
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useHubLayout.setState({ layout: null, kept: null });
});

describe("the Floor with no bossed group", () => {
  it("is drawn as it was before sections, whatever the hub says of groups", async () => {
    const before = await drawn(plain());
    expect(before).toContain("Right now");
    expect(before).toContain("Activity");
    expect(before).toMatchSnapshot();
    expect(await drawn(stamped())).toBe(before);
  });
});
