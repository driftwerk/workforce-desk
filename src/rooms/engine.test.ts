import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../testing/sockets";

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../restore/boot", () => ({
  deskState: {
    get: (k: string) => state.get(k),
    set: (k: string, v: unknown) => void state.set(k, v),
    remove: (k: string) => void state.delete(k),
  },
}));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { say, answerForm, prune, closeRoom, retry, RECONNECT_GRACE_MS } = await import("./engine");
const { MAX_HOPS } = await import("./routing");

const ROOM_ID = "6f1c2a4e-0b7d-4c55-9a51-3d2e8f9b1c07";
const CHANNEL = `desk:${ROOM_ID}`;
const ALL = ["desk.place", "desk.stream", "desk.deliveries"];

const room = {
  id: ROOM_ID,
  slug: "release",
  name: "Release",
  channel: CHANNEL,
  members: [
    { hub: "dw", agent: "allan" },
    { hub: "local", agent: "scout" },
  ],
  defaultMember: "dw/allan",
  createdAt: "",
  updatedAt: "",
};

interface Posted {
  author: string;
  content: string;
  threadId?: string | null;
  hop?: number;
  source?: string;
  delivery?: string;
}

const posts: Posted[] = [];
const sources = new Set<string>();
/** What each agent's room conversation has saved, as the hub reads it back. */
const saved = new Map<string, Record<string, unknown>[]>();
const closed: { agent: string; body: unknown }[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Opens the member's conversation as a hub offering `features` would. */
const connect = async (agent: string, features: string[] = ALL) => {
  await vi.waitFor(() => expect(FakeSocket.find("/ws", agent, CHANNEL)).toBeDefined());
  const s = FakeSocket.find("/ws", agent, CHANNEL)!;
  await flush();
  s.receive({ type: "connected", session_id: `s-${agent}`, features });
  return s;
};

/** The member answers ask `ref` with `text`, saved as `id`. */
const answer = (s: FakeSocket, ref: string, id: string, text: string) => {
  s.receive({ type: "typing", turn_ref: ref, id });
  s.receive({ type: "stream_start", turn_ref: ref, id });
  s.receive({ type: "stream_delta", turn_ref: ref, id, content: text });
  s.receive({ type: "stream_end", turn_ref: ref, id });
  s.receive({ type: "turn_end", turn_ref: ref, id });
};

const keep = (agent: string, m: Record<string, unknown>) => saved.set(agent, [...(saved.get(agent) ?? []), m]);

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.reset();
  state.clear();
  posts.length = 0;
  sources.clear();
  saved.clear();
  closed.length = 0;
  prune({});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: URL | string, init?: RequestInit) => {
      const url = new URL(u);
      const read = /^\/api\/desk\/conversations\/([^/]+)$/.exec(url.pathname);
      if (read) {
        const all = saved.get(decodeURIComponent(read[1]!)) ?? [];
        const after = url.searchParams.get("after");
        const from = after ? all.findIndex((m) => m.id === after) + 1 : 0;
        return json({ messages: all.slice(from), more: false });
      }
      const close = /^\/api\/desk\/conversations\/([^/]+)\/close$/.exec(url.pathname);
      if (close) {
        closed.push({ agent: close[1]!, body: JSON.parse(String(init?.body)) });
        return json({ copied: 0 });
      }
      return json({}, 404);
    }),
  );
  useChat.setState({
    hubs: [
      { id: "dw", label: "Driftwerk", url: "https://dw.example.com", local: false, token: "t" },
      { id: "local", label: "Local", url: "http://127.0.0.1:1", local: true, token: "t" },
    ],
    roster: [
      { hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false },
      { hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false },
      { hubId: "dw", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false },
    ],
    people: { local: "Kingsley" },
  });
  let n = 0;
  useDesk.setState({
    rooms: { [ROOM_ID]: room },
    timelines: { [ROOM_ID]: [] },
    roomDrafts: {},
    hub: {
      post: async (roomId: string, m: Posted) => {
        const created = !m.source || !sources.has(m.source);
        if (m.source) sources.add(m.source);
        if (created) posts.push(m);
        const message = { id: `p${++n}`, roomId, threadId: m.threadId ?? null, hop: m.hop ?? 0, createdAt: new Date(n * 1000).toISOString(), ...m };
        return { message, created };
      },
      updateRoom: async (id: string, patch: { members: typeof room.members }) => ({ ...useDesk.getState().rooms[id]!, ...patch }),
    } as never,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const drafts = () => useDesk.getState().roomDrafts[ROOM_ID] ?? [];

describe("asking a room's members", () => {
  it("sends a structured turn: the room, the thread, who's speaking and what was said since", async () => {
    useDesk.setState({
      timelines: {
        [ROOM_ID]: [
          { id: "root", roomId: ROOM_ID, threadId: null, author: "you", content: "Cut 0.9 today?", hop: 0, createdAt: "1" },
          { id: "r1", roomId: ROOM_ID, threadId: "root", author: "local/scout", content: "CI is green", hop: 0, createdAt: "2" },
        ],
      },
    });
    await say(room, "@allan anything blocking?", "root");
    const allan = await connect("allan");
    await vi.waitFor(() => expect(allan.chats).toHaveLength(1));
    const chat = allan.chats[0]!;
    expect(chat).toMatchObject({
      content: "@allan anything blocking?",
      channel: CHANNEL,
      answers_approvals: true,
      desk: {
        place: { kind: "room", room: ROOM_ID, name: "Release", thread: "root" },
        speaker: { kind: "person" },
        hop: 0,
        message: "p1",
        spoken: false,
        context: [
          { from: "Kingsley", text: "Cut 0.9 today?" },
          { from: "Scout (agent)", text: "CI is green" },
        ],
      },
    });
    expect(typeof chat.turn_ref).toBe("string");
    expect(drafts()).toMatchObject([{ member: "dw/allan", threadId: "root", state: "live" }]);
  });

  it("answers a form in a thread to the agent that posted it, there, and its answer lands in the thread", async () => {
    const form = { id: "f1", roomId: ROOM_ID, threadId: "t1", author: "local/scout", content: "Pick a branch", hop: 0, createdAt: "1" };
    useDesk.setState({ timelines: { [ROOM_ID]: [form] } });
    await answerForm(room, form, "Branch: main (mentions @allan)");
    const scout = await connect("scout");
    await vi.waitFor(() => expect(scout.chats).toHaveLength(1));
    expect(FakeSocket.find("/ws", "allan", CHANNEL)).toBeUndefined();
    expect(posts).toEqual([expect.objectContaining({ author: "you", content: "Branch: main (mentions @allan)", threadId: "t1" })]);
    const chat = scout.chats[0]!;
    expect(chat).toMatchObject({ desk: { place: { kind: "room", room: ROOM_ID, name: "Release", thread: "t1" }, speaker: { kind: "person" } } });
    keep("scout", { id: "m5", from: "agent", text: "Using main.", mark: { room: ROOM_ID, thread: "t1" } });
    answer(scout, chat.turn_ref as string, "m5", "Using main.");
    await vi.waitFor(() =>
      expect(posts.filter((p) => p.author === "local/scout")).toEqual([expect.objectContaining({ content: "Using main.", threadId: "t1" })]),
    );
  });

  it("streams a draft in its thread and posts the saved answer once, from the drain", async () => {
    await say(room, "@allan status?", "t1");
    const allan = await connect("allan");
    await vi.waitFor(() => expect(allan.chats).toHaveLength(1));
    const ref = allan.chats[0]!.turn_ref as string;
    allan.receive({ type: "typing", turn_ref: ref, id: "m9" });
    allan.receive({ type: "stream_start", turn_ref: ref, id: "m9" });
    allan.receive({ type: "stream_delta", turn_ref: ref, id: "m9", content: "Two left" });
    expect(drafts()[0]).toMatchObject({ text: "Two left", threadId: "t1", source: "dw/allan/m9" });
    keep("allan", { id: "m9", from: "agent", text: "Two left.", mark: { room: ROOM_ID, thread: "t1" } });
    allan.receive({ type: "stream_end", turn_ref: ref, id: "m9" });
    allan.receive({ type: "turn_end", turn_ref: ref, id: "m9" });
    await vi.waitFor(() => expect(drafts()).toEqual([]));
    expect(posts.filter((p) => p.author === "dw/allan")).toEqual([
      expect.objectContaining({ content: "Two left.", threadId: "t1", source: "dw/allan/m9", hop: 0 }),
    ]);
    expect(state.get(`drain.dw.allan.${CHANNEL}`)).toBe("m9");
  });

  it("queues a second thread's ask until the first answer ends, so each lands in its own thread", async () => {
    await say(room, "@allan one", "t1");
    await say(room, "@allan two", "t2");
    const allan = await connect("allan");
    await vi.waitFor(() => expect(allan.chats).toHaveLength(1));
    expect(drafts().map((d) => [d.threadId, d.state])).toEqual([
      ["t1", "live"],
      ["t2", "queued"],
    ]);
    keep("allan", { id: "a1", from: "agent", text: "first", mark: { room: ROOM_ID, thread: "t1" } });
    answer(allan, allan.chats[0]!.turn_ref as string, "a1", "first");
    await vi.waitFor(() => expect(allan.chats).toHaveLength(2));
    expect((allan.chats[1]!.desk as { place: { thread: string } }).place.thread).toBe("t2");
    keep("allan", { id: "a2", from: "agent", text: "second", mark: { room: ROOM_ID, thread: "t2" } });
    answer(allan, allan.chats[1]!.turn_ref as string, "a2", "second");
    await vi.waitFor(() => expect(posts.filter((p) => p.author === "dw/allan")).toHaveLength(2));
    expect(posts.filter((p) => p.author === "dw/allan").map((p) => [p.threadId, p.content])).toEqual([
      ["t1", "first"],
      ["t2", "second"],
    ]);
  });

  it("hands an answer on to the member it mentions, and stops at the last hop", async () => {
    await say(room, "@allan start", null);
    const sockets: Record<string, FakeSocket> = { allan: await connect("allan") };
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const [agent, other] = hop % 2 === 0 ? ["allan", "scout"] : ["scout", "allan"];
      const who = (sockets[agent] ??= await connect(agent));
      const asked = Math.floor(hop / 2) + 1;
      await vi.waitFor(() => expect(who.chats).toHaveLength(asked));
      const chat = who.chats[asked - 1]!;
      expect((chat.desk as { hop: number }).hop).toBe(hop);
      if (hop > 0) expect((chat.desk as { speaker: unknown }).speaker).toEqual({ kind: "agent", name: other === "allan" ? "Allan" : "Scout" });
      keep(agent, { id: `h${hop}`, from: "agent", text: `over to you @${other}`, mark: { room: ROOM_ID } });
      answer(who, chat.turn_ref as string, `h${hop}`, `over to you @${other}`);
      await vi.waitFor(() => expect(posts).toHaveLength(hop + 2));
    }
    await flush();
    expect(posts.at(-1)).toMatchObject({ hop: MAX_HOPS });
    expect(sockets.allan!.chats.length + sockets.scout!.chats.length).toBe(MAX_HOPS + 1);
  });

  it("posts a delivery it drains and hands it on to no one", async () => {
    await say(room, "@allan remind me", null);
    const allan = await connect("allan");
    await vi.waitFor(() => expect(allan.chats).toHaveLength(1));
    keep("allan", { id: "d1", from: "agent", text: "🔔 Reminder: ask @scout", mark: { room: ROOM_ID, delivery: "reminder" } });
    answer(allan, allan.chats[0]!.turn_ref as string, "d1", "ok");
    await vi.waitFor(() => expect(posts.some((p) => p.delivery === "reminder")).toBe(true));
    expect(posts.find((p) => p.delivery === "reminder")).toMatchObject({ hop: 0, source: "dw/allan/d1" });
    await flush();
    expect(FakeSocket.find("/ws", "scout", CHANNEL)).toBeUndefined();
  });

  it("posts what was streamed, keyed by its id, on a hub that keeps no conversations for Desk", async () => {
    await say(room, "@allan status?", null);
    const allan = await connect("allan", ["desk.place", "desk.stream"]);
    await vi.waitFor(() => expect(allan.chats).toHaveLength(1));
    answer(allan, allan.chats[0]!.turn_ref as string, "m1", "All green");
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toMatchObject({ author: "dw/allan", content: "All green", source: "dw/allan/m1" });
  });

  it("speaks a hub without structured turns in the room's own words, and posts its answer", async () => {
    await say(room, "what is left?", null);
    const allan = await connect("allan", []);
    await vi.waitFor(() => expect(allan.chats).toHaveLength(1));
    expect(allan.chats[0]).toMatchObject({ content: "[#release] you: what is left?" });
    expect(allan.chats[0]!.desk).toBeUndefined();
    allan.receive({ type: "message", content: "Two PRs." });
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toMatchObject({ author: "dw/allan", content: "Two PRs.", hop: 0 });
    expect(posts[1]!.source).toBeUndefined();
  });

  it("takes a follow-up in the same thread into the live answer", async () => {
    await say(room, "@allan check CI", "t1");
    const allan = await connect("allan");
    await vi.waitFor(() => expect(allan.chats).toHaveLength(1));
    const ref = allan.chats[0]!.turn_ref as string;
    allan.receive({ type: "typing", turn_ref: ref, id: "m1" });
    await say(room, "@allan and the docs", "t1");
    await vi.waitFor(() => expect(allan.chats).toHaveLength(2));
    allan.receive({ type: "injected", content: "Follow-up absorbed into active run" });
    expect(drafts()).toHaveLength(1);
    keep("allan", { id: "m1", from: "agent", text: "Both green.", mark: { room: ROOM_ID, thread: "t1" } });
    answer(allan, ref, "m1", "Both green.");
    await vi.waitFor(() => expect(drafts()).toEqual([]));
    expect(posts.filter((p) => p.author === "dw/allan")).toHaveLength(1);
  });

  it("carries a draft on through a reconnect from the hub's snapshot, without repeating it", async () => {
    await say(room, "@allan long one", null);
    const allan = await connect("allan");
    await vi.waitFor(() => expect(allan.chats).toHaveLength(1));
    const ref = allan.chats[0]!.turn_ref as string;
    allan.receive({ type: "stream_start", turn_ref: ref, id: "m1" });
    allan.receive({ type: "stream_delta", turn_ref: ref, id: "m1", content: "Part one. " });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    allan.drop();
    expect(drafts()[0]).toMatchObject({ state: "stalled" });
    vi.advanceTimersByTime(1_000);
    vi.useRealTimers();
    const again = await connect("allan");
    again.receive({ type: "turn_snapshot", turn_ref: ref, id: "m1", status: "writing", since: new Date().toISOString(), text: "Part one. Part two. " });
    again.receive({ type: "stream_delta", turn_ref: ref, id: "m1", content: "Part three." });
    expect(drafts()[0]).toMatchObject({ state: "live", text: "Part one. Part two. Part three." });
  });

  it("shows an answer that never came as interrupted, and asks again on Retry", async () => {
    await say(room, "@allan long one", null);
    const allan = await connect("allan");
    await vi.waitFor(() => expect(allan.chats).toHaveLength(1));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    allan.drop();
    vi.advanceTimersByTime(1_000);
    vi.useRealTimers();
    await connect("allan");
    await new Promise((r) => setTimeout(r, RECONNECT_GRACE_MS + 100));
    await vi.waitFor(() => expect(drafts()[0]).toMatchObject({ state: "interrupted" }));
    retry(ROOM_ID, drafts()[0]!.id);
    const after = FakeSocket.find("/ws", "allan", CHANNEL)!;
    await vi.waitFor(() => expect(after.chats).toHaveLength(1));
    expect(after.chats[0]!.turn_ref).not.toBe(allan.chats[0]!.turn_ref);
  }, 10_000);

  it("waits a busy refusal out, then asks again", async () => {
    await say(room, "@allan one", null);
    const allan = await connect("allan");
    await vi.waitFor(() => expect(allan.chats).toHaveLength(1));
    allan.receive({ type: "error", turn_ref: allan.chats[0]!.turn_ref, content: "busy" });
    expect(drafts()[0]).toMatchObject({ state: "queued" });
  });

  it("tells each member's hub when the room is deleted, and remembers it deleted it", async () => {
    await closeRoom(room);
    expect(closed).toEqual([
      { agent: "allan", body: { channel: CHANNEL, undelivered: [] } },
      { agent: "scout", body: { channel: CHANNEL, undelivered: [] } },
    ]);
    expect(state.get("rooms.deleted")).toEqual([ROOM_ID]);
  });

  it("keys a room made before channels were frozen by its slug", async () => {
    const old = { ...room, channel: undefined };
    useDesk.setState({ rooms: { [ROOM_ID]: old } });
    await say(old, "hello", null);
    await vi.waitFor(() => expect(FakeSocket.find("/ws", "allan", "desk:release")).toBeDefined());
  });

  it("closes a member's conversation when its hub is paired again", async () => {
    await say(room, "hello", null);
    const first = await connect("allan");
    prune(useDesk.getState().rooms, [
      { id: "dw", label: "Driftwerk", url: "https://dw.example.com", local: false, token: "new" },
      { id: "local", label: "Local", url: "http://127.0.0.1:1", local: true, token: "t" },
    ]);
    expect(first.readyState).toBe(FakeSocket.CLOSED);
  });
});
