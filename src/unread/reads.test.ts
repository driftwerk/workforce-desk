import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../restore/boot", () => ({
  deskState: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => void state.set(k, v), remove: (k: string) => void state.delete(k) },
}));
const conversationReads = vi.hoisted(() => [] as unknown[]);
vi.mock("../hubs/surface", () => ({
  putConversationRead: vi.fn(async (_hub: unknown, agent: string, read: unknown) => void conversationReads.push({ agent, read })),
}));

const { useChat } = await import("../chat/store");
const { HubError } = await import("../hub/client");
const { useDesk } = await import("../hub/store");
const { advance, advanced, effective, flushPending, loadLocal, markEverythingRead, markUnread, unreadFrom, useReads } = await import("./reads");

const at = (sec: number) => new Date(Date.UTC(2026, 9, 27, 9, 0, sec)).toISOString();
const ROOM = { kind: "room", room: "r1" } as const;
let puts: unknown[][] = [];
let reachable = true;

beforeEach(() => {
  state.clear();
  conversationReads.length = 0;
  puts = [];
  reachable = true;
  useReads.setState({ local: {}, dms: {}, loaded: true });
  useChat.setState({
    hubs: [
      { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" },
      { id: "dw", label: "Atlas", url: "https://atlas.example.com", local: false, revision: "t" },
    ],
    hubFeatures: { dw: new Set(["desk.reads"]) },
  });
  useDesk.setState({
    hub: {
      putReads: vi.fn(async (p: { place: string; point: { at: string; message: string | null } }[]) => {
        if (!reachable) throw new TypeError("Failed to fetch");
        puts.push(p);
        return p.map((x) => ({ place: x.place, ...x.point }));
      }),
    } as never,
  });
});

describe("a read point", () => {
  it("never moves back", () => {
    const point = { at: at(5), message: "m5" };
    expect(advanced(point, { id: "m4", createdAt: at(4) })).toBeNull();
    expect(advanced(point, { id: "m5", createdAt: at(5) })).toBeNull();
    expect(advanced(point, { id: "m6", createdAt: at(6) })).toEqual({ at: at(6), message: "m6" });
    expect(advanced(null, { id: "m1", createdAt: at(1) })).toEqual({ at: at(1), message: "m1" });
  });

  it("counts from Desk's floor when it is older or there is none", () => {
    expect(effective(null, at(3))).toEqual({ at: at(3), message: null });
    expect(effective({ at: at(1), message: "m1" }, at(3))).toEqual({ at: at(3), message: null });
    expect(effective({ at: at(5), message: "m5" }, at(3))).toEqual({ at: at(5), message: "m5" });
  });

  it("is set just before the first loaded message when there's none before it", () => {
    expect(unreadFrom({ createdAt: at(4) }, { id: "m3", createdAt: at(3) })).toEqual({ at: at(3), message: "m3" });
    const first = unreadFrom({ createdAt: at(4) }, null);
    expect(first.message).toBeNull();
    expect(Date.parse(first.at)).toBeLessThan(Date.parse(at(4)));
  });
});

describe("writing read points", () => {
  it("advances on this computer's hub only past where it is, and sets on Mark unread", async () => {
    await advance(ROOM, { at: at(5), message: "m5" });
    await advance(ROOM, { at: at(4), message: "m4" });
    await markUnread(ROOM, { at: at(2), message: "m2" });
    expect(puts).toEqual([
      [{ place: "room:r1", point: { at: at(5), message: "m5" }, mark: "advance" }],
      [{ place: "room:r1", point: { at: at(2), message: "m2" }, mark: "set" }],
    ]);
    expect(useReads.getState().local["room:r1"]).toEqual({ at: at(2), message: "m2" });
  });

  it("writes a DM's point on its agent's hub", async () => {
    await advance({ kind: "dm", hub: "dw", agent: "allan" }, { at: at(7), message: "d7" });
    expect(conversationReads).toEqual([{ agent: "allan", read: { channel: "desk", at: at(7), message: "d7", mark: "advance" } }]);
    expect(useReads.getState().dms["dw/allan"]).toEqual({ at: at(7), message: "d7" });
  });

  it("writes no DM point to a hub that said it keeps none, and asks one not heard from here", async () => {
    useChat.setState({ hubFeatures: { dw: new Set(["desk.floor"]) } });
    await advance({ kind: "dm", hub: "dw", agent: "allan" }, { at: at(7), message: "d7" });
    expect(conversationReads).toEqual([]);
    useChat.setState({ hubFeatures: {} });
    await advance({ kind: "dm", hub: "dw", agent: "allan" }, { at: at(8), message: "d8" });
    expect(conversationReads).toHaveLength(1);
  });

  it("drops a DM point its hub can't keep (503) rather than waiting to send it", async () => {
    const { putConversationRead } = await import("../hubs/surface");
    vi.mocked(putConversationRead).mockRejectedValueOnce(new HubError(503, "this hub keeps no read points"));
    await advance({ kind: "dm", hub: "dw", agent: "allan" }, { at: at(9), message: "d9" });
    expect(state.get("unread.pending.dw")).toBeUndefined();
  });

  it("keeps what the hub couldn't take while it was away, and sends each as it was made when it's back", async () => {
    reachable = false;
    await advance(ROOM, { at: at(5), message: "m5" });
    await markUnread({ kind: "thread", room: "r1", thread: "t1" }, { at: at(1), message: null });
    expect(state.get("unread.pending.local")).toHaveLength(2);
    reachable = true;
    await flushPending("local");
    expect(puts.flat()).toEqual([
      { place: "room:r1", point: { at: at(5), message: "m5" }, mark: "advance" },
      { place: "thread:r1/t1", point: { at: at(1), message: null }, mark: "set" },
    ]);
    expect(state.get("unread.pending.local")).toBeUndefined();
  });

  it("drops a write the hub refused", async () => {
    useDesk.setState({ hub: { putReads: vi.fn(async () => Promise.reject(new HubError(400, "no such place"))) } as never });
    await advance(ROOM, { at: at(5), message: "m5" });
    expect(state.get("unread.pending.local")).toBeUndefined();
  });
});

describe("a machine's session's point", () => {
  it("is written on the machine's engine as its own place, and kept here under its key", async () => {
    const theirs: unknown[][] = [];
    const devbox = {
      putReads: vi.fn(async (p: { place: string; point: { at: string; message: string | null } }[]) => {
        theirs.push(p);
        return p.map((x) => ({ place: x.place, ...x.point }));
      }),
    };
    useDesk.setState({ engines: { devbox: { hub: devbox as never, connected: true, loaded: true, error: null } } });
    await advance({ kind: "session", session: "devbox/s1" }, { at: at(5), message: null });
    expect(theirs).toEqual([[{ place: "session:s1", point: { at: at(5), message: null }, mark: "advance" }]]);
    expect(puts).toEqual([]);
    expect(useReads.getState().local["session:devbox/s1"]).toEqual({ at: at(5), message: null });
    expect(useReads.getState().local["session:s1"]).toBeUndefined();
    useDesk.setState({ engines: {} });
  });
});

describe("this computer's points and the machines'", () => {
  it("are read afresh on a snapshot without losing the machines' sessions' points", () => {
    useReads.setState({ local: { "session:devbox/s1": { at: at(1), message: null }, "room:gone": { at: at(1), message: null } }, dms: {}, loaded: false });
    loadLocal([{ place: "room:r1", at: at(2), message: "m1" }]);
    expect(useReads.getState().local).toEqual({ "session:devbox/s1": { at: at(1), message: null }, "room:r1": { at: at(2), message: "m1" } });
    expect(useReads.getState().loaded).toBe(true);
  });

  it("are all marked read at once: each connected machine in parallel, none that isn't", async () => {
    let release!: (rows: { place: string; at: string; message: null }[]) => void;
    const slow = { markAllRead: vi.fn(() => new Promise<{ place: string; at: string; message: null }[]>((r) => (release = r))) };
    const quick = { markAllRead: vi.fn(async () => [{ place: "session:s9", at: at(3), message: null }]) };
    const away = { markAllRead: vi.fn(async () => []) };
    const local = useDesk.getState().hub as unknown as Record<string, unknown>;
    useDesk.setState({
      hub: { ...local, markAllRead: vi.fn(async () => []) } as never,
      engines: {
        devbox: { hub: slow as never, connected: true, loaded: true, error: null },
        spare: { hub: quick as never, connected: true, loaded: true, error: null },
        gone: { hub: away as never, connected: false, loaded: true, error: null },
      },
    });
    const done = markEverythingRead({}, null);
    await vi.waitFor(() => expect(quick.markAllRead).toHaveBeenCalled());
    // The second was asked while the first still hadn't answered.
    expect(slow.markAllRead).toHaveBeenCalled();
    expect(away.markAllRead).not.toHaveBeenCalled();
    release([{ place: "session:s1", at: at(4), message: null }]);
    await done;
    expect(useReads.getState().local["session:devbox/s1"]).toEqual({ at: at(4), message: null });
    expect(useReads.getState().local["session:spare/s9"]).toEqual({ at: at(3), message: null });
    useDesk.setState({ engines: {} });
  });
});
