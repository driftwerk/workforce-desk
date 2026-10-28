import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyConversation, type ConversationState } from "./conversation";
import { covered, fetchHistory, prepend, withHistory } from "./history";
import { useChat } from "./store";
import type { ChatMessage, HubAccount } from "./types";

/** The DMs opened, to tell what they hear and see what they're told. */
const opened = vi.hoisted(() => [] as { change: (s: ConversationState) => void; dropped: Set<string>[] }[]);

vi.mock("./conversation", async (original) => ({
  ...(await original<typeof import("./conversation")>()),
  Conversation: class {
    dropped: Set<string>[] = [];
    constructor(_hub: unknown, _agent: unknown, readonly change: (s: ConversationState) => void) {
      opened.push(this);
    }
    send() {
      return true;
    }
    drop(ids: Set<string>) {
      this.dropped.push(ids);
    }
    cancel() {}
    close() {}
  },
}));

const hub: HubAccount = { id: "local", label: "This Mac", url: "http://127.0.0.1:4100", local: true, token: "tok" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const msg = (id: string, role: ChatMessage["role"], content: string, at = "2026-10-28T09:00:00.000Z"): ChatMessage => ({
  id,
  role,
  content,
  at,
  status: "complete",
  tools: [],
});

const fetched: URL[] = [];
const answer = (f: (url: URL) => Response) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      fetched.push(new URL(u));
      return f(new URL(u));
    }),
  );

beforeEach(() => {
  fetched.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("reading a DM's history", () => {
  it("reads the latest page, oldest first, as chat messages", async () => {
    answer(() =>
      json({
        messages: [
          { id: "h1", from: "user", text: "what's open?", at: "2026-10-27T10:00:00Z" },
          { id: "h2", from: "agent", text: "Two PRs.\n\n```chart\n{}\n```", at: "2026-10-27T10:00:05Z" },
        ],
        more: true,
      }),
    );
    const page = await fetchHistory(hub, "release captain");
    expect(fetched[0]!.pathname).toBe("/api/desk/conversations/release%20captain");
    expect(fetched[0]!.searchParams.get("limit")).toBe("200");
    expect(fetched[0]!.searchParams.has("before")).toBe(false);
    expect(page).toEqual({
      more: true,
      messages: [
        msg("h1", "user", "what's open?", "2026-10-27T10:00:00Z"),
        msg("h2", "assistant", "Two PRs.\n\n```chart\n{}\n```", "2026-10-27T10:00:05Z"),
      ],
    });
  });

  it("asks for the page before a message", async () => {
    answer(() => json({ messages: [], more: false }));
    await fetchHistory(hub, "scout", "h1");
    expect(fetched[0]!.searchParams.get("before")).toBe("h1");
  });

  it("finds nothing, quietly, on a hub without the route", async () => {
    answer(() => json({ error: "not found" }, 404));
    expect(await fetchHistory(hub, "scout")).toBeNull();
    answer(() => new Response("<!doctype html><title>Hub</title>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(await fetchHistory(hub, "scout")).toBeNull();
    answer(() => new Response("", { status: 405 }));
    expect(await fetchHistory(hub, "scout")).toBeNull();
  });

  it("fails on anything else", async () => {
    answer(() => json({ error: "boom" }, 500));
    await expect(fetchHistory(hub, "scout")).rejects.toThrow();
  });
});

describe("history and live messages together", () => {
  const history = [msg("h1", "user", "hi"), msg("h2", "assistant", "Hello.")];
  const loadedAt = "2026-10-28T10:00:00.000Z";

  it("puts an earlier page first, each message once", () => {
    expect(prepend([msg("h0", "user", "x"), msg("h1", "user", "hi")], history).map((m) => m.id)).toEqual(["h0", "h1", "h2"]);
  });

  it("shows live messages after the history", () => {
    const live = [msg("m-1", "user", "and now?", "2026-10-28T10:01:00.000Z")];
    expect(withHistory(history, live, loadedAt).map((m) => m.id)).toEqual(["h1", "h2", "m-1"]);
  });

  it("drops live messages the history already has when it was read after them", () => {
    const live = [msg("m-1", "user", "hi", "2026-10-28T09:59:00.000Z"), msg("m-2", "assistant", "Hello.", "2026-10-28T09:59:30.000Z")];
    expect(withHistory(history, live, loadedAt).map((m) => m.id)).toEqual(["h1", "h2"]);
    const answeredLater = [live[0]!, { ...live[1]!, at: "2026-10-28T10:00:30.000Z" }];
    expect(withHistory(history.slice(0, 1), answeredLater, loadedAt).map((m) => m.id)).toEqual(["h1", "m-2"]);
  });

  it("drops an answer the socket repeats before you've said anything", () => {
    const echo = [msg("m-1", "assistant", "Hello.", "2026-10-28T10:05:00.000Z")];
    expect(withHistory(history, echo, loadedAt).map((m) => m.id)).toEqual(["h1", "h2"]);
  });

  it("keeps the same words said again after the history was read", () => {
    const again = [msg("m-1", "user", "hi", "2026-10-28T10:05:00.000Z"), msg("m-2", "assistant", "Hello.", "2026-10-28T10:05:09.000Z")];
    expect(withHistory(history, again, loadedAt).map((m) => m.id)).toEqual(["h1", "h2", "m-1", "m-2"]);
  });
});

describe("the live messages the hub's copy now shows", () => {
  const before = "2026-10-28T10:00:00.000Z";
  const at = "2026-10-28T09:59:00.000Z";

  it("are the ones it has, matched in order from the end", () => {
    const kept = [
      msg("h1", "user", "hi", at),
      msg("h2", "assistant", "Hello.", at),
      msg("h3", "user", "Atlas asks: how is staging?", at),
      msg("h4", "assistant", "Green.", "2026-10-28T09:59:08.000Z"),
    ];
    const live = [msg("m-1", "user", "hi", at), msg("m-2", "assistant", "Hello.", at), msg("m-3", "assistant", "Green.", at)];
    expect([...covered(kept, live, before)].sort()).toEqual(["m-1", "m-2", "m-3"]);
  });

  it("leave a reply it hasn't kept yet live, even when an older one says the same", () => {
    const kept = [msg("h1", "assistant", "Done.", "2026-10-28T08:00:00.000Z"), msg("h2", "user", "Atlas asks: and the docs?", at)];
    expect(covered(kept, [msg("m-1", "assistant", "Done.", at)], before).size).toBe(0);
  });

  it("leave errors, unfinished answers and anything after the read alone", () => {
    const kept = [msg("h1", "assistant", "Green.", at)];
    expect(covered(kept, [{ ...msg("m-1", "assistant", "Green.", at), status: "streaming" }], before).size).toBe(0);
    expect(covered(kept, [msg("m-1", "assistant", "Green.", "2026-10-28T10:00:01.000Z")], before).size).toBe(0);
    expect(covered([msg("h1", "system", "x", at)], [msg("m-1", "system", "x", at)], before).size).toBe(0);
  });
});

describe("a DM's history in the store", () => {
  const agent = { hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false };

  beforeEach(() => {
    useChat.setState({ hubs: [hub], roster: [agent], conversations: {}, histories: {}, activeAgent: null });
  });
  afterEach(() => useChat.getState().forget("local/scout"));

  it("reads it when the DM opens, and pages back with the earliest id", async () => {
    answer((u) =>
      u.searchParams.get("before") === "h3"
        ? json({ messages: [{ id: "h1", from: "user", text: "a" }, { id: "h2", from: "agent", text: "b" }], more: false })
        : json({ messages: [{ id: "h3", from: "user", text: "c" }, { id: "h4", from: "agent", text: "d" }], more: true }),
    );
    useChat.getState().openDm("local/scout");
    await vi.waitFor(() => expect(useChat.getState().histories["local/scout"]?.state).toBe("ready"));
    expect(useChat.getState().histories["local/scout"]!.messages.map((m) => m.id)).toEqual(["h3", "h4"]);
    await useChat.getState().loadEarlier("local/scout");
    const h = useChat.getState().histories["local/scout"]!;
    expect(h.messages.map((m) => m.id)).toEqual(["h1", "h2", "h3", "h4"]);
    expect(h.more).toBe(false);
    await useChat.getState().loadEarlier("local/scout");
    expect(fetched).toHaveLength(2);
  });

  it("starts empty, with no error, on a hub that doesn't keep it", async () => {
    answer(() => json({ error: "not found" }, 404));
    useChat.getState().openDm("local/scout");
    await vi.waitFor(() => expect(useChat.getState().histories["local/scout"]?.state).toBe("absent"));
    expect(useChat.getState().histories["local/scout"]!.messages).toEqual([]);
  });

  it("says it failed, and reads it again when the DM is opened again", async () => {
    answer(() => json({ error: "boom" }, 502));
    useChat.getState().openDm("local/scout");
    await vi.waitFor(() => expect(useChat.getState().histories["local/scout"]?.state).toBe("failed"));
    answer(() => json({ messages: [{ id: "h1", from: "agent", text: "hi" }], more: false }));
    useChat.getState().openDm("local/scout");
    await vi.waitFor(() => expect(useChat.getState().histories["local/scout"]?.state).toBe("ready"));
  });

  it("reads it again after a turn you didn't start, so what the overseer asked shows, and the live copies give way", async () => {
    answer(() => json({ messages: [{ id: "h1", from: "user", text: "hi" }, { id: "h2", from: "agent", text: "Hello." }], more: false }));
    useChat.getState().openDm("local/scout");
    await vi.waitFor(() => expect(useChat.getState().histories["local/scout"]?.state).toBe("ready"));
    const dm = opened.at(-1)!;
    const answerLive = msg("m-1", "assistant", "Staging is green.", "2026-10-28T09:00:00.000Z");
    const live: ConversationState = { ...emptyConversation(), connected: true, messages: [answerLive] };
    answer(() =>
      json({
        messages: [
          { id: "h1", from: "user", text: "hi" },
          { id: "h2", from: "agent", text: "Hello." },
          { id: "h3", from: "user", text: "Atlas asks: how is staging?" },
          { id: "h4", from: "agent", text: "Staging is green." },
        ],
        more: false,
      }),
    );
    dm.change({ ...live, working: { since: 0, step: "Writing" }, unprompted: true });
    expect(fetched).toHaveLength(1);
    dm.change(live);
    await vi.waitFor(() => expect(useChat.getState().histories["local/scout"]!.messages.map((m) => m.id)).toEqual(["h1", "h2", "h3", "h4"]));
    expect(dm.dropped).toEqual([new Set(["m-1"])]);
  });

  it("isn't read again after a turn you started", async () => {
    answer(() => json({ messages: [], more: false }));
    useChat.getState().openDm("local/scout");
    await vi.waitFor(() => expect(useChat.getState().histories["local/scout"]?.state).toBe("ready"));
    const dm = opened.at(-1)!;
    const live: ConversationState = { ...emptyConversation(), connected: true };
    dm.change({ ...live, working: { since: 0, step: "Sending" } });
    dm.change(live);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetched).toHaveLength(1);
  });

  it("keeps what an overseer's messages offer to act on, even with no text", async () => {
    const desk = { suggestions: [{ id: "sg-1", text: "Stop the test.", state: "open" }] };
    answer(() =>
      json({
        messages: [
          { id: "h1", from: "agent", text: "It looks stuck.", desk },
          { id: "h2", from: "agent", text: "", desk },
          { id: "h3", from: "agent", text: "" },
          { id: "h4", from: "user", text: "ok", desk },
        ],
        more: false,
      }),
    );
    const page = await fetchHistory(hub, "desk");
    expect(page!.messages.map((m) => [m.id, m.desk])).toEqual([
      ["h1", desk],
      ["h2", desk],
      ["h4", undefined],
    ]);
  });
});
