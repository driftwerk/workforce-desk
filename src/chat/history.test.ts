import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyConversation, type ConversationState } from "./conversation";
import { covered, cursorIn, fetchHistory, prepend, readConversation, withHistory } from "./history";
import { useChat } from "./store";
import type { ChatMessage, HubAccount } from "./types";

/** The DMs opened, to tell what they hear and see what they're told. */
const opened = vi.hoisted(
  () => [] as { change: (s: ConversationState) => void; dropped: Set<string>[]; sent: unknown[][]; forgotten: string[] }[],
);

vi.mock("./conversation", async (original) => ({
  ...(await original<typeof import("./conversation")>()),
  Conversation: class {
    dropped: Set<string>[] = [];
    sent: unknown[][] = [];
    forgotten: string[] = [];
    constructor(_hub: unknown, _agent: unknown, readonly change: (s: ConversationState) => void) {
      opened.push(this);
    }
    send(...args: unknown[]) {
      this.sent.push(args);
      return { turnRef: "t1" };
    }
    forget(ref: string) {
      this.forgotten.push(ref);
    }
    drop(ids: Set<string>) {
      this.dropped.push(ids);
    }
    cancel() {}
    close() {}
  },
}));

const hub: HubAccount = { id: "local", label: "This computer", url: "http://127.0.0.1:4100", local: true, token: "tok" };

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

  it("says who said each message, where the hub does", async () => {
    answer(() =>
      json({
        messages: [
          { id: "h1", from: "user", author: { kind: "overseer", id: "atlas", name: "Atlas" }, text: "Atlas asks: and staging?" },
          { id: "h2", from: "agent", author: { kind: "agent", id: "scout", name: "Scout" }, text: "Green." },
          { id: "h3", from: "user", author: { kind: "someone", id: "x", name: "X" }, text: "hi" },
          { id: "h4", from: "user", text: "older" },
        ],
        more: false,
      }),
    );
    const page = await fetchHistory(hub, "scout");
    expect(page!.messages.map((m) => m.author)).toEqual([
      { kind: "overseer", id: "atlas", name: "Atlas" },
      { kind: "agent", id: "scout", name: "Scout" },
      undefined,
      undefined,
    ]);
    expect("author" in page!.messages[3]!).toBe(false);
  });

  it("reads where a message was delivered, its files (as the hub's own, whatever they claim), and a room's page after a message", async () => {
    const file = { artifact_id: "art_1", media_type: "application/pdf", filename: "q3.pdf", size: 9, thumbnail_url: null };
    answer(() =>
      json({
        messages: [
          { id: "h1", from: "agent", text: "🔔 Reminder: stand-up", mark: { delivery: "reminder" } },
          { id: "h2", from: "agent", text: "", mark: { delivery: "approval", request_id: "q1" } },
          { id: "file:art_1", from: "agent", text: "", attachments: [{ ...file, hub: "local", agent: "overseer" }] },
          { id: "h3", from: "agent", text: "" },
        ],
        more: false,
      }),
    );
    const page = await fetchHistory(hub, "scout");
    expect(page!.messages.map((m) => [m.id, m.delivery, m.requestId, m.attachments])).toEqual([
      ["h1", "reminder", undefined, undefined],
      ["h2", "approval", "q1", undefined],
      ["file:art_1", undefined, undefined, [file]],
    ]);
    answer(() => json({ messages: [], more: false }));
    await readConversation(hub, "scout", { channel: "desk:6f1c", after: "m4" });
    expect(Object.fromEntries(fetched.at(-1)!.searchParams)).toEqual({ limit: "200", channel: "desk:6f1c", after: "m4" });
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

  it("shows a message the hub sent live by its id once, kept or not", () => {
    const sent = { ...msg("h3", "user", "Atlas asks: and staging?", "2026-10-28T10:05:00.000Z"), sentOn: true };
    const answer = msg("m-1", "assistant", "Green.", "2026-10-28T10:05:09.000Z");
    expect(withHistory(history, [sent, answer], loadedAt).map((m) => m.id)).toEqual(["h1", "h2", "h3", "m-1"]);
    const reread = [
      ...history,
      msg("h3", "user", "Atlas asks: and staging?", "2026-10-28T10:05:00.000Z"),
      msg("h4", "assistant", "Green.", "2026-10-28T10:05:09.000Z"),
    ];
    expect(withHistory(reread, [sent, answer], "2026-10-28T10:06:00.000Z").map((m) => m.id)).toEqual(["h1", "h2", "h3", "h4"]);
    expect([...covered(reread, [sent, answer], "2026-10-28T10:06:00.000Z")].sort()).toEqual(["h3", "m-1"]);
  });

  it("keeps the same words said again after the history was read", () => {
    const again = [msg("m-1", "user", "hi", "2026-10-28T10:05:00.000Z"), msg("m-2", "assistant", "Hello.", "2026-10-28T10:05:09.000Z")];
    expect(withHistory(history, again, loadedAt).map((m) => m.id)).toEqual(["h1", "h2", "m-1", "m-2"]);
  });
});

describe("the live messages the hub's copy now shows", () => {
  const before = "2026-10-28T10:00:00.000Z";
  const at = "2026-10-28T09:59:00.000Z";

  it("are known by their id on a hub that streams answers by it, never by what they say", () => {
    const kept = [msg("h1", "user", "status?"), msg("r1", "assistant", "Green.")];
    const live = [msg("m-1", "user", "status?"), msg("r9", "assistant", "Green."), msg("r1", "assistant", "Green.")];
    expect([...covered(kept, live, before, true)].sort()).toEqual(["m-1", "r1"]);
    expect([...covered(kept, live.slice(0, 2), before)].sort()).toEqual(["m-1", "r9"]);
  });

  it("are paged from a message of the transcript, never a file of its own", () => {
    const page = [msg("file:a", "assistant", ""), msg("h1", "user", "x"), msg("h2", "assistant", "y"), msg("file:b", "assistant", "")];
    expect([cursorIn(page, "first"), cursorIn(page, "last"), cursorIn([page[0]!], "last")]).toEqual(["h1", "h2", undefined]);
  });

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

  it("sends a DM turn, spoken when said aloud, with its files", async () => {
    answer(() => json({ messages: [], more: false }));
    useChat.getState().openDm("local/scout");
    await vi.waitFor(() => expect(useChat.getState().histories["local/scout"]?.state).toBe("ready"));
    const dm = opened.at(-1)!;
    const file = { artifact_id: "art_1", media_type: "text/plain", filename: "a.txt", size: 1 };
    const aloud = { reply: "spoken", speech: { provider: "fish_audio", model: "s1" } } as const;
    expect(useChat.getState().send("local/scout", "status?", { voice: aloud, attachments: [file] })).toBe(true);
    expect(dm.sent.at(-1)).toEqual([
      "status?",
      {
        turn: { place: { kind: "dm" }, speaker: { kind: "person" }, hop: 0, context: [], spoken: true, voice: aloud },
        attachments: [file],
      },
    ]);
  });

  it("sends a dictated turn as not spoken, and a typed one with no voice", async () => {
    answer(() => json({ messages: [], more: false }));
    useChat.getState().openDm("local/scout");
    await vi.waitFor(() => expect(useChat.getState().histories["local/scout"]?.state).toBe("ready"));
    const dm = opened.at(-1)!;
    useChat.getState().send("local/scout", "note this", { voice: { reply: "written" } });
    expect(dm.sent.at(-1)?.[1]).toEqual({
      turn: { place: { kind: "dm" }, speaker: { kind: "person" }, hop: 0, context: [], spoken: false, voice: { reply: "written" } },
      attachments: undefined,
    });
    useChat.getState().send("local/scout", "typed");
    expect(dm.sent.at(-1)?.[1]).toEqual({
      turn: { place: { kind: "dm" }, speaker: { kind: "person" }, hop: 0, context: [], spoken: false },
      attachments: undefined,
    });
  });

  it("reads it again once a turn ends, then forgets the turn", async () => {
    answer(() => json({ messages: [{ id: "r1", from: "agent", text: "Green." }], more: false }));
    useChat.getState().openDm("local/scout");
    await vi.waitFor(() => expect(useChat.getState().histories["local/scout"]?.state).toBe("ready"));
    const dm = opened.at(-1)!;
    const reads = fetched.length;
    const ended = { ref: "t1", replyId: "r1", text: "Green.", working: null, tools: [], attachments: [], state: "ended" as const, acked: true };
    dm.change({ ...emptyConversation(), connected: true, turns: { t1: ended } });
    dm.change({ ...emptyConversation(), connected: true, turns: { t1: ended } });
    await vi.waitFor(() => expect(dm.forgotten).toEqual(["t1"]));
    expect(fetched.length).toBe(reads + 1);
  });

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
    dm.change({ ...live, working: { since: 0, at: 0, phase: "writing", step: "Writing" }, unprompted: true });
    expect(fetched).toHaveLength(1);
    dm.change(live);
    await vi.waitFor(() => expect(useChat.getState().histories["local/scout"]!.messages.map((m) => m.id)).toEqual(["h1", "h2", "h3", "h4"]));
    expect(dm.dropped).toEqual([new Set(["m-1"])]);
  });

  it("isn't read again after a turn whose prompt came live", async () => {
    answer(() => json({ messages: [], more: false }));
    useChat.getState().openDm("local/scout");
    await vi.waitFor(() => expect(useChat.getState().histories["local/scout"]?.state).toBe("ready"));
    const dm = opened.at(-1)!;
    const live: ConversationState = { ...emptyConversation(), connected: true };
    dm.change({ ...live, working: { since: 0, at: 0, phase: "thinking", step: "Thinking" }, unprompted: true });
    dm.change({ ...live, working: { since: 0, at: 0, phase: "thinking", step: "Thinking" }, unprompted: false });
    dm.change(live);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetched).toHaveLength(1);
  });

  it("is read again after a turn you didn't start on a paired hub too, which may not send its prompt live", async () => {
    const remote: HubAccount = { ...hub, id: "dw", local: false };
    useChat.setState({ hubs: [remote], roster: [{ ...agent, hubId: "dw" }] });
    answer(() => json({ messages: [], more: false }));
    useChat.getState().openDm("dw/scout");
    await vi.waitFor(() => expect(useChat.getState().histories["dw/scout"]?.state).toBe("ready"));
    const dm = opened.at(-1)!;
    const live: ConversationState = { ...emptyConversation(), connected: true };
    dm.change({ ...live, working: { since: 0, at: 0, phase: "writing", step: "Writing" }, unprompted: true });
    dm.change(live);
    await vi.waitFor(() => expect(fetched).toHaveLength(2));
    useChat.getState().forget("dw/scout");
  });

  it("knows who you are on each hub that says, with your picture there", async () => {
    answer((u) =>
      u.pathname === "/api/me"
        ? json({ id: u.host === "dw.example" ? "u-dw" : "u-local", display_name: " Sam ", picture: { version: "v1", source: "slack", at: "2026-10-30T09:00:00Z", slack: "Acme" } })
        : json({ agents: [{ id: "scout", name: "Scout" }] }),
    );
    useChat.setState({ me: {} });
    useChat.getState().setHubs([hub, { ...hub, id: "dw", url: "https://dw.example", local: false }]);
    await vi.waitFor(() => expect(Object.keys(useChat.getState().me).sort()).toEqual(["dw", "local"]));
    expect(useChat.getState().me.dw).toEqual({ id: "u-dw", name: "Sam", picture: { version: "v1", source: "slack", at: "2026-10-30T09:00:00Z", slack: "Acme" } });
  });

  it("does without you where the hub won't say who you are", async () => {
    answer((u) => (u.pathname === "/api/me" ? json({ error: "no" }, 404) : json({ agents: [] })));
    useChat.setState({ me: {} });
    useChat.getState().setHubs([hub]);
    await vi.waitFor(() => expect(fetched.some((u) => u.pathname === "/api/me")).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(useChat.getState().me).toEqual({});
  });

  it("isn't read again after a turn you started", async () => {
    answer(() => json({ messages: [], more: false }));
    useChat.getState().openDm("local/scout");
    await vi.waitFor(() => expect(useChat.getState().histories["local/scout"]?.state).toBe("ready"));
    const dm = opened.at(-1)!;
    const live: ConversationState = { ...emptyConversation(), connected: true };
    dm.change({ ...live, working: { since: 0, at: 0, phase: "sending", step: "Sending" } });
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
