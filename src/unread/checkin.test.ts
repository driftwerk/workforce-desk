import { beforeEach, describe, expect, it, vi } from "vitest";

// The overseer's check-in is one thing in two places, the brief and its
// answer in the overseer's DM: reading either reads the other, and it's
// counted once.

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../restore/boot", () => ({
  deskState: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => void state.set(k, v), remove: (k: string) => void state.delete(k) },
}));
const conversationReads = vi.hoisted(() => [] as unknown[]);
vi.mock("../hubs/surface", async (real) => ({
  ...(await real<object>()),
  putConversationRead: vi.fn(async (_hub: unknown, agent: string, read: unknown) => void conversationReads.push({ agent, read })),
}));
const page = vi.hoisted(() => ({ messages: [] as unknown[], more: false }));
vi.mock("../chat/history", async (real) => ({ ...(await real<object>()), readConversation: vi.fn(async () => page) }));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useOverview } = await import("../overview/store");
const { advance, useReads } = await import("./reads");
const { unreadRows } = await import("./rows");
const { notHere, totalOf } = await import("./badges");
const { dmsFrom } = await import("./summary");

const at = (min: number) => new Date(Date.UTC(2026, 9, 30, 9, min)).toISOString();
const brief = { text: "Three things moved overnight.", at: at(10), by: { id: "desk", name: "Desk" } };
const hubs = [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, token: "t" }];
let puts: { place: string; point: unknown }[] = [];

beforeEach(() => {
  state.clear();
  conversationReads.length = 0;
  puts = [];
  page.messages = [];
  page.more = false;
  useReads.setState({ local: {}, dms: {}, loaded: true });
  useChat.setState({ hubs, hubFeatures: {} });
  useOverview.setState({ overview: { brief, counts: { working: 0, needsYou: 0, doneToday: 0 }, items: [] } });
  useDesk.setState({
    hub: {
      putReads: vi.fn(async (p: { place: string; point: { at: string; message: string | null } }[]) => {
        puts.push(...p);
        return p.map((x) => ({ place: x.place, ...x.point }));
      }),
    } as never,
  });
});

describe("the overseer's check-in", () => {
  it("reads the brief when its DM is read through the check-in's answer", async () => {
    await advance({ kind: "dm", hub: "local", agent: "desk" }, { at: at(11), message: "a1" });
    expect(puts).toEqual([{ place: "brief", point: { at: at(11), message: null }, mark: "advance" }]);
    expect(useReads.getState().local.brief).toEqual({ at: at(11), message: null });
  });

  it("reads the brief when its hub says the DM was read past it, on another Desk", async () => {
    dmsFrom(hubs[0]!, [{ agent_id: "desk", channel: "desk", updated_at: at(12), read: { at: at(12), message_id: "a1" }, unread: null }]);
    await vi.waitFor(() => expect(puts).toEqual([{ place: "brief", point: { at: at(12), message: null }, mark: "advance" }]));
  });

  it("is read on the page without waiting for its hub to count again", () => {
    const local = { floor: at(0), rooms: [], sessions: [], activity: { count: 0, lastAt: null }, brief: at(10), update: null };
    expect(notHere(local, { brief: { at: at(11), message: null } }, () => false)?.brief).toBeNull();
    expect(notHere(local, { brief: { at: at(9), message: null } }, () => false)?.brief).toBe(at(10));
  });

  it("leaves the brief unread for a DM read only to before the check-in, or another agent's DM", async () => {
    await advance({ kind: "dm", hub: "local", agent: "desk" }, { at: at(9), message: "a0" });
    await advance({ kind: "dm", hub: "local", agent: "allan" }, { at: at(12), message: "b1" });
    expect(puts).toEqual([]);
  });

  it("reads the DM through the check-in's answer when the brief is read", async () => {
    page.messages = [
      { id: "u0", from: "user", text: "hi", at: at(5) },
      { id: "a0", from: "assistant", text: "hello", at: at(6) },
      { id: "a1", from: "assistant", text: "Three things moved overnight.\n\nMore.", at: at(11) },
      { id: "a2", from: "assistant", text: "And a later one", at: at(20) },
    ];
    await advance({ kind: "brief" }, { at: at(10), message: null });
    expect(conversationReads).toEqual([{ agent: "desk", read: { channel: "desk", at: at(11), message: "a1", mark: "advance" } }]);
    expect(useReads.getState().dms["local/desk"]).toEqual({ at: at(11), message: "a1" });
  });

  it("doesn't guess the answer from a page that starts after the check-in", async () => {
    page.messages = [{ id: "a5", from: "assistant", text: "later", at: at(30) }];
    page.more = true;
    await advance({ kind: "brief" }, { at: at(10), message: null });
    expect(conversationReads).toEqual([]);
  });

  it("is one row, counted once, while its answer is unread in the DM", () => {
    const sources = {
      local: { floor: at(0), rooms: [], sessions: [], activity: { count: 0, lastAt: null }, brief: at(10), update: null },
      dms: { "local/desk": { count: 1, for_you: 1, first: "a1", last: { at: at(11), message_id: "a1" }, capped: false } },
      rooms: {},
      roster: [{ hubId: "local", id: "desk", name: "Desk", model: null, provider: null, isDefault: false }],
      hubs,
      sessions: {},
      sessionNames: {},
      timelines: {},
      brief,
      ready: null,
      readyAt: at(0),
    };
    const rows = unreadRows(sources);
    expect(rows.map((r) => r.key)).toEqual(["dm:local/desk"]);
    expect(rows[0]!.where).toBe("Desk report · DM · This computer");
    expect(totalOf({ needs: [], rows, drafts: {} })).toEqual({ count: 1, dot: false });
    // Its DM read, the brief is its own row again until it's read too.
    expect(unreadRows({ ...sources, dms: {} }).map((r) => r.key)).toEqual(["brief"]);
  });
});
