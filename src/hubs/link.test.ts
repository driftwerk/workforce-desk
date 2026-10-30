import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubAccount } from "../chat/types";
import { FakeSocket } from "../testing/sockets";

const state = vi.hoisted(() => new Map<string, unknown>());
const drained = vi.hoisted(() => [] as { hub: string; agent: string; channel: string }[]);
const notified = vi.hoisted(() => [] as { title: string; body: string }[]);
const spoken = vi.hoisted(() => [] as string[]);
const said = vi.hoisted(() => ({ messages: [] as { id: string; from: string; text: string }[], done: true }));

vi.mock("../restore/boot", () => ({
  deskState: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => void state.set(k, v), remove: (k: string) => void state.delete(k) },
}));
vi.mock("../rooms/engine", () => ({
  drainer: {
    drain: async (hub: HubAccount, agent: string, channel: string) => {
      drained.push({ hub: hub.id, agent, channel });
      return said.done;
    },
    said: (_hub: string, _agent: string, id: string) => said.messages.find((m) => m.id === id),
  },
}));
vi.mock("../shell/notify", () => ({ notify: async (n: { title: string; body: string }) => void notified.push(n) }));
vi.mock("../voice/useVoice", () => ({ readAloud: (_agent: unknown, text: string) => void spoken.push(text) }));
const floor = vi.hoisted(() => ({ heard: [] as [string, string[]][], unheard: [] as string[], asked: [] as string[][] }));
vi.mock("../floor/store", () => ({
  floorHeard: (hubId: string, features: ReadonlySet<string>) => void floor.heard.push([hubId, [...features]]),
  floorUnheard: (hubId: string) => void floor.unheard.push(hubId),
  ask: (hubIds: readonly string[]) => void floor.asked.push([...hubIds]),
}));

const { HubLink, linkUrl } = await import("./link");
const { CATCH_UP_RETRY_MS, followHubs, sinceOf, SINCE_MARGIN_MS } = await import("./follow");
const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");

const hub: HubAccount = { id: "dw", label: "Driftwerk", url: "https://dw.example.com", local: false, token: "tok" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const flush = () => new Promise((r) => setTimeout(r, 0));

let conversations: { agent_id: string; channel: string; updated_at: string }[] = [];
const sinces: (string | null)[] = [];

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.reset();
  state.clear();
  drained.length = 0;
  notified.length = 0;
  spoken.length = 0;
  sinces.length = 0;
  said.messages = [];
  said.done = true;
  conversations = [];
  floor.heard.length = 0;
  floor.unheard.length = 0;
  floor.asked.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: URL | string) => {
      const url = new URL(u);
      if (url.pathname === "/api/desk/conversations") {
        sinces.push(url.searchParams.get("since"));
        return json({ conversations });
      }
      return json({}, 404);
    }),
  );
  useChat.setState({
    hubs: [hub],
    roster: [{ hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
    activeAgent: null,
    panelAgent: null,
    dmUnread: {},
  });
});
afterEach(() => {
  followHubs([]);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const events = (over: Partial<import("./link").LinkEvents> = {}): import("./link").LinkEvents => ({
  hello: vi.fn(),
  delivered: vi.fn(),
  changed: vi.fn(),
  closed: vi.fn(),
  unavailable: vi.fn(),
  ...over,
});

const link = async () => {
  followHubs([hub]);
  await vi.waitFor(() => expect(FakeSocket.find("/ws/desk")).toBeDefined());
  await flush();
  return FakeSocket.find("/ws/desk")!;
};

describe("a hub link", () => {
  it("connects to the hub's link with the device's token", () => {
    expect(linkUrl(hub)).toBe("wss://dw.example.com/ws/desk?token=tok");
  });

  it("drains everything that changed since Desk last looked when it says hello", async () => {
    state.set("drain.dw.seen", "2026-10-30T10:00:00.000Z");
    conversations = [
      { agent_id: "allan", channel: "desk", updated_at: "2026-10-30T10:01:00Z" },
      { agent_id: "allan", channel: "desk:6f1c", updated_at: "2026-10-30T10:02:00Z" },
    ];
    const s = await link();
    s.receive({ type: "hello", features: ["desk.place", "desk.stream", "desk.deliveries"] });
    await vi.waitFor(() => expect(drained).toHaveLength(2));
    expect(sinces).toEqual([new Date(Date.parse("2026-10-30T10:00:00.000Z") - SINCE_MARGIN_MS).toISOString()]);
    expect(drained.map((d) => d.channel)).toEqual(["desk", "desk:6f1c"]);
    expect(useChat.getState().hubFeatures.dw?.has("desk.deliveries")).toBe(true);
    await vi.waitFor(() => expect(state.get("drain.dw.seen")).not.toBe("2026-10-30T10:00:00.000Z"));
  });

  it("tries a catch-up that left something undrained again, and only then counts it as looked at", async () => {
    state.set("drain.dw.seen", "2026-10-30T10:00:00.000Z");
    conversations = [{ agent_id: "allan", channel: "desk:6f1c", updated_at: "2026-10-30T10:01:00Z" }];
    said.done = false;
    const s = await link();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    s.receive({ type: "hello", features: ["desk.deliveries"] });
    await vi.waitFor(() => expect(drained).toHaveLength(1));
    expect(state.get("drain.dw.seen")).toBe("2026-10-30T10:00:00.000Z");
    said.done = true;
    await vi.advanceTimersByTimeAsync(CATCH_UP_RETRY_MS);
    await vi.waitFor(() => expect(state.get("drain.dw.seen")).not.toBe("2026-10-30T10:00:00.000Z"));
    expect(drained).toHaveLength(2);
    expect(sinces).toHaveLength(2);
  });

  it("drains a delivery's conversation, counts it unread in its DM, tells you, and reads a spoken one aloud", async () => {
    said.messages = [{ id: "m1", from: "agent", text: "🔔 Reminder: stand-up\nin five" }];
    const s = await link();
    s.receive({
      type: "desk_delivered",
      agent_id: "allan",
      channel: "desk",
      session_id: "s1",
      message_id: "m1",
      kind: "reminder",
      place: { kind: "dm" },
      spoken: true,
    });
    await vi.waitFor(() => expect(notified).toHaveLength(1));
    expect(drained).toEqual([{ hub: "dw", agent: "allan", channel: "desk" }]);
    expect(notified[0]).toEqual({ title: "Allan · Reminder", body: "🔔 Reminder: stand-up" });
    expect(useChat.getState().dmUnread["dw/allan"]).toBe(1);
    expect(spoken).toEqual(["🔔 Reminder: stand-up\nin five"]);
  });

  it("counts unread for the DM last opened while a room or the Floor is shown instead, and none while it's shown", () => {
    useChat.setState({ activeAgent: "dw/allan", panelAgent: null, dmUnread: {} });
    useDesk.setState({ view: "floor", activeRoom: null });
    useChat.getState().bumpDm("dw/allan");
    useDesk.setState({ view: "rooms", activeRoom: "6f1c" });
    useChat.getState().bumpDm("dw/allan");
    useDesk.setState({ activeRoom: null });
    useChat.getState().bumpDm("dw/allan");
    expect(useChat.getState().dmUnread["dw/allan"]).toBe(2);
  });

  it("tells you of nothing a notice says, and counts no unread for a room", async () => {
    const s = await link();
    s.receive({ type: "desk_delivered", agent_id: "allan", channel: "desk:6f1c", session_id: "s1", message_id: "m1", kind: "notice", place: { kind: "room", room: "6f1c", name: "R" } });
    await vi.waitFor(() => expect(drained).toHaveLength(1));
    await flush();
    expect(notified).toEqual([]);
    expect(useChat.getState().dmUnread).toEqual({});
  });

  it("is given up on a hub too old to have one, until it is paired again", async () => {
    const unavailable = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    new HubLink(hub, events({ unavailable }));
    const s = FakeSocket.find("/ws/desk")!;
    s.drop();
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledWith("legacy"));
  });

  it("is given up when the hub takes this computer for nobody", async () => {
    const unavailable = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: URL | string) => (new URL(u).pathname === "/api/me" ? new Response("", { status: 401 }) : new Response("", { status: 400 }))),
    );
    new HubLink(hub, events({ unavailable }));
    FakeSocket.find("/ws/desk")!.drop();
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledWith("unlinked"));
  });

  it("reconnects after a link that was open drops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const unavailable = vi.fn();
    new HubLink(hub, events({ unavailable }));
    await Promise.resolve();
    FakeSocket.find("/ws/desk")!.drop();
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.opened.filter((s) => s.url.includes("/ws/desk"))).toHaveLength(2);
    expect(unavailable).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("reads the hub's floor on its hello and on each signal, and stops counting on it once the link drops", async () => {
    const s = await link();
    s.receive({ type: "hello", features: ["desk.deliveries", "desk.floor", "desk.usage"] });
    expect(floor.heard).toEqual([["dw", ["desk.deliveries", "desk.floor", "desk.usage"]]]);
    s.receive({ type: "floor_changed" });
    s.receive({ type: "usage_changed" });
    s.receive({ type: "something_else" });
    expect(floor.asked).toEqual([["dw"], ["dw"]]);
    s.drop();
    expect(floor.unheard).toEqual(["dw"]);
  });

  it("says which change a signal is, and that a link once open dropped", async () => {
    const changed = vi.fn();
    const closed = vi.fn();
    new HubLink(hub, events({ changed, closed }));
    const s = FakeSocket.find("/ws/desk")!;
    await Promise.resolve();
    s.receive({ type: "usage_changed" });
    s.receive({ type: "floor_changed" });
    expect(changed.mock.calls).toEqual([["usage"], ["floor"]]);
    s.drop();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("stops counting on a hub's link when the hub is no longer followed", async () => {
    await link();
    followHubs([]);
    expect(floor.unheard).toEqual(["dw"]);
  });

  it("looks back a little before when it last looked", () => {
    expect(sinceOf(undefined)).toBeNull();
    expect(sinceOf("2026-10-30T10:05:00.000Z")).toBe("2026-10-30T10:00:00.000Z");
  });
});
