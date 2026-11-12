import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyConversation } from "./conversation";
import { useChat, turnOf } from "./store";
import { contextBefore, copyToChat, CONTEXT_LINES, fetchThreads, splitKey, threadChannel, threadKey } from "./thread";
import type { Agent, ChatMessage, HubAccount } from "./types";

const net = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../hub/net", async (original) => ({
  ...(await original<typeof import("../hub/net")>()),
  pairedHub: () => net,
}));

const hub: HubAccount = { id: "acme", label: "Acme", url: "https://hub.example.com", local: false, revision: "t" };
const agent: Agent = { hubId: "acme", id: "scout", name: "Scout", model: null, provider: null, isDefault: false };
const msg = (id: string, role: ChatMessage["role"], content: string): ChatMessage => ({ id, role, content, at: "2026-11-12T10:00:00Z" }) as ChatMessage;

beforeEach(() => net.fetch.mockReset());

describe("A thread's key and channel", () => {
  it("is the agent's key and the parent's id, and splits back", () => {
    expect(threadKey("acme/scout", "p1")).toBe("acme/scout#p1");
    expect(splitKey("acme/scout#p1")).toEqual({ agent: "acme/scout", parent: "p1" });
    expect(splitKey("acme/scout")).toEqual({ agent: "acme/scout" });
    expect(threadChannel("p1")).toBe("desk:thread:p1");
  });
});

describe("What a thread's turn carries", () => {
  it("is the chat up to and including the parent, newest kept, who said it named", () => {
    const chat = [msg("a", "user", "hi"), msg("b", "assistant", "hello"), msg("p", "user", "ship it?"), msg("later", "assistant", "yes")];
    expect(contextBefore(chat, "p", "You", "Scout")).toEqual([
      { from: "You", text: "hi" },
      { from: "Scout", text: "hello" },
      { from: "You", text: "ship it?" },
    ]);
    expect(contextBefore(chat, "missing", "You", "Scout")).toEqual([]);
    const long = Array.from({ length: 50 }, (_, i) => msg(`m${i}`, "user", `line ${i}`));
    const lines = contextBefore(long, "m49", "You", "Scout");
    expect(lines).toHaveLength(CONTEXT_LINES);
    expect(lines.at(-1)?.text).toBe("line 49");
  });

  it("is placed in the thread, and a DM's turn is not", () => {
    useChat.setState({
      hubs: [hub],
      roster: [agent],
      histories: { "acme/scout": { state: "ready", messages: [msg("p", "user", "ship it?")], more: false, earlier: "idle", loadedAt: null } },
    });
    const thread = turnOf("acme/scout#p");
    expect(thread.place).toEqual({ kind: "dm", thread: "p" });
    expect(thread.context).toEqual([{ from: "You", text: "ship it?" }]);
    const dm = turnOf("acme/scout");
    expect(dm.place).toEqual({ kind: "dm" });
    expect(dm.context).toEqual([]);
  });
});

describe("The hub's threads", () => {
  it("lists a DM's threads and skips what isn't one", async () => {
    net.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ threads: [{ parent: "p1", replies: 3, last_at: "2026-11-12T10:00:00Z", authors: ["user", "agent", "x"], working: true }, { nope: 1 }] }),
    });
    expect(await fetchThreads(hub, "scout")).toEqual([{ parent: "p1", replies: 3, lastAt: "2026-11-12T10:00:00Z", authors: ["user", "agent"], working: true }]);
    expect(net.fetch).toHaveBeenCalledWith("GET", "/api/desk/conversations/scout/threads");
  });

  it("sends a reply to the chat, naming the message the thread is on", async () => {
    net.fetch.mockResolvedValue({ ok: true, json: async () => ({ id: "c1" }) });
    expect(await copyToChat(hub, "scout", "p1", "yes, that one")).toBe("c1");
    const [method, path, body] = net.fetch.mock.calls[0]!;
    expect([method, path]).toEqual(["POST", "/api/desk/conversations/scout/messages"]);
    expect(JSON.parse(body.data)).toEqual({ text: "yes, that one", thread_of: "p1" });
  });
});

describe("A DM's threads beside the DM", () => {
  it("each keeps its own queue", () => {
    useChat.setState({ hubs: [hub], roster: [agent], queues: {}, conversations: {}, histories: {}, threads: {} });
    useChat.getState().enqueue("acme/scout#p", "in the thread");
    useChat.getState().enqueue("acme/scout", "in the chat");
    const { queues } = useChat.getState();
    expect(queues["acme/scout#p"]?.items.map((i) => i.text)).toEqual(["in the thread"]);
    expect(queues["acme/scout"]?.items.map((i) => i.text)).toEqual(["in the chat"]);
  });

  it("are forgotten with it, wherever the store holds them, and another agent's are not", () => {
    const history = { state: "ready" as const, messages: [], more: false, earlier: "idle" as const, loadedAt: null };
    const queue = { items: [], paused: false };
    useChat.setState({
      hubs: [hub],
      roster: [agent],
      // Held with no live conversation of their own: only the store's maps know them.
      // One thread only in histories, one only in queues, one only in conversations.
      histories: { "acme/scout": history, "acme/scout#h": history, "acme/other#q": history },
      queues: { "acme/scout#q": queue, "acme/other#q": queue },
      conversations: { "acme/scout#c": emptyConversation() },
      threads: { "acme/scout": [], "acme/other": [] },
    });
    useChat.getState().forget("acme/scout");
    const s = useChat.getState();
    expect(Object.keys(s.histories)).toEqual(["acme/other#q"]);
    expect(Object.keys(s.queues)).toEqual(["acme/other#q"]);
    expect(Object.keys(s.conversations)).toEqual([]);
    expect(Object.keys(s.threads)).toEqual(["acme/other"]);
  });

  it("are not set by a read begun before the DM was forgotten, once it is opened again", async () => {
    const open = () =>
      useChat.setState({ conversations: { "acme/scout": { ...emptyConversation(), features: new Set(["desk.dm_threads"]) } } });
    useChat.setState({ hubs: [hub], roster: [agent], threads: {} });
    open();
    let late!: (r: unknown) => void;
    net.fetch.mockReturnValueOnce(new Promise((resolve) => (late = resolve)));
    const stale = useChat.getState().loadThreads("acme/scout");
    useChat.getState().forget("acme/scout");
    open();
    late({ ok: true, json: async () => ({ threads: [{ parent: "old", replies: 9 }] }) });
    await stale;
    expect(useChat.getState().threads["acme/scout"]).toBeUndefined();
  });
});
