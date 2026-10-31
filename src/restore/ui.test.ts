import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { deskListeners, useDesk } from "../hub/store";
import type { DeskEvent, Room } from "../hub/types";
import { useGrids } from "../grids/store";
import { useUi } from "../shell/ui";
import { followHub, restore, restoreBeforeRender } from "./boot";
import { DeskStateStore, type LocalState, type StateEntry } from "./store";
import { capture, DEFAULT_UI, MAIN_UI_KEY, mainUi, sanitize, type MainUi } from "./ui";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  onNativeState: vi.fn(() => Promise.resolve(() => {})),
  subscribe: vi.fn(() => () => {}),
  stateLoad: vi.fn(),
  statePut: vi.fn(),
  stateRemove: vi.fn(),
  stateSynced: vi.fn(),
  stateAdopt: vi.fn(),
  stateFlush: vi.fn(),
}));

const file = (entries: Record<string, StateEntry> = {}): LocalState => ({
  load: vi.fn(async () => structuredClone(entries)),
  put: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  synced: vi.fn(async () => undefined),
  adopt: vi.fn(async () => true),
  flush: vi.fn(async () => undefined),
});

const saved: MainUi = {
  v: 1,
  view: "rooms",
  room: "r1",
  dm: "local/scout",
  session: "s1",
  panelAgent: "local/ledger",
  grid: "g2",
  settings: "shortcuts",
  agentTabs: { "local/scout": "files" },
  scroll: { sidebar: 120, floor: 40 },
  agentFiles: { "local/scout": "AGENTS.md" },
  roomThreads: { r1: "m7" },
  anchors: { "dm:local/scout": { id: "m3", offset: -12 } },
  panelWidths: { session: 640 },
  panelFocus: { kind: "session", beside: "thread" },
  activity: false,
  inbox: false,
};

const room = (id: string) => ({ id, name: id, members: [] }) as unknown as Room;
const send = (e: DeskEvent) => deskListeners.forEach((f) => f(e));

/** The hub's events socket, driven by the test. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  close() {
    this.onclose?.();
  }
  open() {
    this.onopen?.();
  }
  event(e: DeskEvent) {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}
const latest = () => FakeSocket.all.at(-1)!;

const reset = () => {
  useDesk.setState({ view: "floor", activeRoom: null, openId: null, rooms: {}, sessions: {}, connected: false, hub: null, loaded: false });
  useChat.setState({ activeAgent: null, panelAgent: null, hubs: [], roster: [], rosterErrors: {}, rosterRead: false });
  useUi.setState({ settings: null, agentTabs: {}, scroll: {}, agentFiles: {}, roomThreads: {}, anchors: {}, panelWidths: {}, panelFocus: null, activityOpen: true });
  useGrids.setState({ active: null });
};

beforeEach(reset);
afterEach(() => vi.useRealTimers());

describe("ui.main", () => {
  it("reads whatever was saved field by field, defaulting what it can't", () => {
    expect(sanitize(undefined)).toEqual(DEFAULT_UI);
    expect(sanitize("nonsense")).toEqual(DEFAULT_UI);
    expect(sanitize(saved)).toEqual(saved);
    expect(sanitize({ ...saved, inbox: true }).inbox).toBe(true);
    const { inbox: _older, ...fromOlderDesk } = saved;
    expect(sanitize(fromOlderDesk).inbox).toBe(false);
    expect(
      sanitize({
        view: "grid",
        room: 7,
        settings: "nowhere",
        agentTabs: { a: "files", b: "zzz" },
        scroll: { sidebar: -3, floor: Number.NaN, other: 5 },
        agentFiles: { a: "SOUL.md", b: 3 },
        roomThreads: { r: "", s: "m1" },
        panelAgent: 4,
        anchors: { "dm:a": { id: "m1", offset: 4 }, "dm:b": { id: 2, offset: 0 }, "dm:c": "x" },
        activity: "docked",
        future: true,
      }),
    ).toEqual({
      ...DEFAULT_UI,
      agentTabs: { a: "files" },
      scroll: { other: 5 },
      agentFiles: { a: "SOUL.md" },
      roomThreads: { s: "m1" },
      anchors: { "dm:a": { id: "m1", offset: 4 } },
    });
  });

  it("captures what's shown and puts it back", () => {
    useDesk.setState({ view: "rooms", activeRoom: "r1", openId: "s1" });
    useChat.setState({ activeAgent: "local/scout", panelAgent: "local/ledger" });
    useUi.setState({
      settings: "shortcuts",
      agentTabs: { "local/scout": "files" },
      scroll: { sidebar: 120, floor: 40 },
      agentFiles: { "local/scout": "AGENTS.md" },
      roomThreads: { r1: "m7" },
      anchors: { "dm:local/scout": { id: "m3", offset: -12 } },
      panelWidths: { session: 640 },
      panelFocus: { kind: "session", beside: "thread" },
      activityOpen: false,
    });
    useGrids.setState({ active: "g2" });
    const ui = capture();
    expect(ui).toEqual(saved);
    reset();
    mainUi.write(ui);
    expect(capture()).toEqual(saved);
  });
});

describe("the DM put back beside the Floor", () => {
  const LOCAL = { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, token: "t" };
  const OFFICE = { id: "office", label: "Office", url: "http://127.0.0.1:2", local: false, token: "t" };
  /** Each hub's agents, as `/api/agents` lists them; a hub missing here
   *  doesn't answer. */
  const agentsOn = (lists: Record<string, string[]>) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        const ids = lists[url.port === "1" ? "local" : "office"];
        return ids ? new Response(JSON.stringify({ agents: ids.map((id) => ({ id })) })) : new Response("", { status: 502, statusText: "Bad Gateway" });
      }),
    );
  afterEach(() => vi.unstubAllGlobals());

  const launch = async (panelAgent: string, lists: Record<string, string[]>, hubs = [LOCAL, OFFICE]) => {
    agentsOn(lists);
    mainUi.write({ ...saved, view: "floor", panelAgent });
    expect(useChat.getState().panelAgent).toBe(panelAgent);
    useChat.getState().setHubs(hubs);
    await vi.waitFor(() => expect(useChat.getState().rosterRead).toBe(true));
    return useChat.getState().panelAgent;
  };

  it("stays once its hub lists the agent", async () => {
    expect(await launch("office/ada", { local: ["scout"], office: ["ada"] })).toBe("office/ada");
  });

  it("goes once its hub has been read without the agent", async () => {
    expect(await launch("office/ada", { local: ["scout"], office: ["grace"] })).toBeNull();
  });

  it("stays while its hub doesn't answer", async () => {
    expect(await launch("office/ada", { local: ["scout"] })).toBe("office/ada");
  });

  it("goes when its hub isn't paired any more", async () => {
    expect(await launch("office/ada", { local: ["scout"] }, [LOCAL])).toBeNull();
  });
});

describe("restoring on launch", () => {
  it("shows what was open before anything renders, and the defaults never overwrite it", async () => {
    const local = file({ [MAIN_UI_KEY]: { value: saved, dirty: false } });
    const store = new DeskStateStore(local);
    (await restoreBeforeRender([mainUi], store))();
    expect(useDesk.getState()).toMatchObject({ view: "rooms", activeRoom: "r1", openId: "s1" });
    expect(useChat.getState().activeAgent).toBe("local/scout");
    expect(useUi.getState()).toMatchObject({ settings: "shortcuts", agentTabs: { "local/scout": "files" } });
    expect(local.put).not.toHaveBeenCalled();
  });

  it("opens on the defaults when Desk's file can't be read", async () => {
    const local = file();
    local.load = vi.fn(() => Promise.reject(new Error("unreadable")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    (await restoreBeforeRender([mainUi], new DeskStateStore(local)))();
    expect(capture()).toEqual(DEFAULT_UI);
  });

  it("every change is saved", async () => {
    const local = file();
    const store = new DeskStateStore(local);
    await store.load();
    restore(store, mainUi);
    useDesk.getState().setView("rooms");
    expect(local.put).toHaveBeenLastCalledWith(MAIN_UI_KEY, expect.objectContaining({ view: "rooms" }));
    useUi.getState().openSettings("voices");
    expect(local.put).toHaveBeenLastCalledWith(MAIN_UI_KEY, expect.objectContaining({ settings: "voices" }));
    useUi.getState().closeSettings();
    useUi.getState().setAgentTab("local/scout", "settings");
    expect(store.get(MAIN_UI_KEY)).toMatchObject({ settings: null, agentTabs: { "local/scout": "settings" } });
    // Something else changing (a session event) is no new save.
    const calls = vi.mocked(local.put).mock.calls.length;
    useDesk.setState({ sessions: {} });
    expect(vi.mocked(local.put).mock.calls.length).toBe(calls);
  });

  it("a value the hub replaces is shown", async () => {
    const store = new DeskStateStore(file());
    restore(store, mainUi);
    await store.heard(MAIN_UI_KEY, { ...saved, view: "floor", room: null });
    expect(useDesk.getState()).toMatchObject({ view: "floor", activeRoom: null, openId: "s1" });
  });
});

describe("through a hub restart", () => {
  const messages = vi.fn(async () => new Response("[]", { headers: { "content-type": "application/json" } }));
  let stop: () => void = () => {};
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", messages);
    messages.mockClear();
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
  });

  it("keeps the view and selection, and reads the open room again when it's back", async () => {
    mainUi.write(saved);
    stop = useDesk.getState().connect({ url: "http://127.0.0.1:1", token: "t" });
    latest().open();
    latest().event({ type: "snapshot", sessions: [], restore: [], rooms: [room("r1"), room("r2")] });
    expect(useDesk.getState()).toMatchObject({ view: "rooms", activeRoom: "r1", openId: "s1", loaded: true });
    await vi.advanceTimersByTimeAsync(0);
    const reads = messages.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    // The hub restarts: the socket drops, Desk tries again, the hub is back.
    latest().close();
    expect(useDesk.getState()).toMatchObject({ connected: false, view: "rooms", activeRoom: "r1", openId: "s1" });
    await vi.advanceTimersByTimeAsync(600);
    latest().open();
    latest().event({ type: "snapshot", sessions: [], restore: [], rooms: [room("r1")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(useDesk.getState()).toMatchObject({ connected: true, view: "rooms", activeRoom: "r1", openId: "s1" });
    expect(useChat.getState().activeAgent).toBe("local/scout");
    expect(useUi.getState().settings).toBe("shortcuts");
    expect(messages.mock.calls.length).toBeGreaterThan(reads);
    expect(String((messages.mock.calls.at(-1) as unknown[])[0])).toContain("/api/desk/rooms/r1/messages");
  });

  it("a room deleted while Desk was closed is no longer open", () => {
    mainUi.write(saved);
    stop = useDesk.getState().connect({ url: "http://127.0.0.1:1", token: "t" });
    latest().open();
    latest().event({ type: "snapshot", sessions: [], restore: [], rooms: [room("r2")] });
    expect(useDesk.getState().activeRoom).toBeNull();
    expect(useDesk.getState().view).toBe("rooms");
  });

  it("asks the hub for Desk's state on every snapshot, one read at a time", async () => {
    const store = new DeskStateStore(file());
    let finish = () => {};
    const connect = vi.spyOn(store, "connect").mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const stop = followHub(store);
    const hub = { stateList: vi.fn(async () => []), statePut: vi.fn(), stateRemove: vi.fn(), roomMessages: vi.fn(async () => []) };
    useDesk.setState({ hub: hub as never, connected: true });
    const snapshot: DeskEvent = { type: "snapshot", sessions: [], restore: [], rooms: [] };
    send(snapshot);
    expect(connect).toHaveBeenCalledTimes(1);
    // Two more while the first is reading: one more read, after it.
    send(snapshot);
    send(snapshot);
    expect(connect).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    finish();
    await Promise.resolve();
    // A snapshot without a reconnection (events missed) reads it again too.
    send(snapshot);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
    finish();
    send({ type: "state", key: MAIN_UI_KEY, value: saved });
    stop();
  });
});
