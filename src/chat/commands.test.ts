import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../testing/sockets";
import { Conversation, RECONNECT_GRACE_MS, toShow, UNCONFIRMED_MS } from "./conversation";
import { keptOf, shownWith } from "./reconcile";
import { commandMarkdown, matching, type HubCommand } from "./commands";
import { FEATURES, type ChatMessage, type DeskTurn, type HubAccount } from "./types";

// What you send in a DM never sits waiting at the bottom of it: a command the
// hub answered itself is settled there as a command, and a message the hub
// never said it had shows as not delivered, after a minute or a lost
// connection, rather than waiting on a copy that won't come.

const hub: HubAccount = { id: "dw", label: "Driftwerk", url: "http://127.0.0.1:9", local: false, revision: "t" };
const dm: DeskTurn = { place: { kind: "dm" }, speaker: { kind: "person" }, hop: 0, context: [], spoken: false };
const features = [FEATURES.place, FEATURES.stream, FEATURES.queue, FEATURES.clientIds];

const kept = (id: string, role: ChatMessage["role"], content: string, at: string, more: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  content,
  at,
  status: "complete",
  tools: [],
  ...more,
});

const open = async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  const c = new Conversation(hub, "atlas", () => {});
  const socket = FakeSocket.find("/ws", "atlas")!;
  await Promise.resolve();
  socket.receive({ type: "connected", session_id: "s1", features });
  return { c, socket };
};

/** Sends `content`, and the client id and turn it went under. */
const say = (c: Conversation, socket: FakeSocket, content: string) => {
  const sent = c.send(content, { turn: dm });
  if (!sent || !sent.turnRef) throw new Error("not sent");
  const frame = socket.chats.at(-1) as { desk: { message: string } };
  return { ref: sent.turnRef, clientId: frame.desk.message };
};

/** The hub answers turn `ref` itself, as it does a command. */
const answersItself = (socket: FakeSocket, ref: string, text: string) => {
  socket.receive({ type: "typing", turn_ref: ref, id: `reply-${ref}` });
  socket.receive({ type: "message", content: text, turn_ref: ref, id: `reply-${ref}` });
  socket.receive({ type: "turn_end", turn_ref: ref, command: true });
};

/** Time passes with the hub there: it answers every ping. */
const wait = async (socket: FakeSocket, ms: number) => {
  for (let left = ms; left > 0; left -= 10_000) {
    await vi.advanceTimersByTimeAsync(Math.min(10_000, left));
    socket.receive({ type: "pong" });
  }
};

const shown = (page: ChatMessage[], c: Conversation) => {
  const live = toShow(c.current.messages).filter((m) => !keptOf(page, c.current.messages).has(m.id));
  return shownWith(page, live).map((m) => m.content);
};

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-10T09:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a command in a DM", () => {
  it("settles with its answer as a command, kept nowhere, and isn't sent again", async () => {
    const { c, socket } = await open();
    const { ref, clientId } = say(c, socket, "/status");
    answersItself(socket, ref, "🤖 *Session Status*\n  Model: `sonnet`");
    const [asked, answer] = c.current.messages;
    expect(asked).toMatchObject({ role: "user", clientId, command: true, unkept: true });
    expect(asked!.undelivered).toBeUndefined();
    expect(answer).toMatchObject({ role: "assistant", command: true, unkept: true, status: "complete" });
    expect(c.current.working).toBeNull();
    // A minute on, it's still settled, never "not delivered", and went once.
    await wait(socket, UNCONFIRMED_MS + 5_000);
    expect(c.current.messages.every((m) => !m.undelivered)).toBe(true);
    expect(socket.chats).toHaveLength(1);
  });

  it("stays where it was said, above what you said next within the minute", async () => {
    const { c, socket } = await open();
    const earlier = kept("k1", "user", "what's open?", "2026-11-10T08:50:00.000Z", { seq: 1 });
    const { ref } = say(c, socket, "/status");
    answersItself(socket, ref, "Model: sonnet");
    vi.setSystemTime(new Date("2026-11-10T09:00:20.000Z"));
    const next = say(c, socket, "and the release?");
    socket.receive({ type: "stream_start", turn_ref: next.ref, id: "r2" });
    socket.receive({ type: "stream_delta", content: "Tomorrow.", turn_ref: next.ref, id: "r2" });
    socket.receive({ type: "turn_end", turn_ref: next.ref, id: "r2" });
    // The hub kept the later exchange, a few seconds after the command.
    const page = [
      earlier,
      kept("k2", "user", "and the release?", "2026-11-10T09:00:20.000Z", { clientId: next.clientId, seq: 2 }),
      kept("r2", "assistant", "Tomorrow.", "2026-11-10T09:00:25.000Z", { replyTo: next.clientId, seq: 3 }),
    ];
    expect(shown(page, c)).toEqual(["what's open?", "/status", "Model: sonnet", "and the release?", "Tomorrow."]);
  });

  it("settles an unknown command the same way, with the hub's plain answer", async () => {
    const { c, socket } = await open();
    const { ref } = say(c, socket, "/clear2");
    answersItself(socket, ref, "Unknown command `/clear2`. Type `/help` for what this agent understands.");
    expect(c.current.messages.map((m) => [m.role, m.command, m.unkept])).toEqual([
      ["user", true, true],
      ["assistant", true, true],
    ]);
    expect(c.current.messages[1]!.content).toMatch(/^Unknown command/);
    await wait(socket, UNCONFIRMED_MS + 5_000);
    expect(c.current.messages[0]!.undelivered).toBeUndefined();
  });
});

describe("a message the hub never said it had", () => {
  it("shows as not delivered once a minute goes by unheard, and as delivered if word comes late", async () => {
    const { c, socket } = await open();
    const { ref } = say(c, socket, "deploy it");
    await wait(socket, UNCONFIRMED_MS - 10_000);
    expect(c.current.messages[0]!.undelivered).toBeUndefined();
    await wait(socket, 20_000);
    expect(c.current.messages[0]).toMatchObject({ content: "deploy it", undelivered: true });
    expect(c.current.working).toBeNull();
    // It got there after all.
    socket.receive({ type: "typing", turn_ref: ref, id: "r1" });
    expect(c.current.messages[0]!.undelivered).toBeUndefined();
  });

  it("is not delivered when the connection drops before the hub says it has it", async () => {
    const { c, socket } = await open();
    say(c, socket, "deploy it");
    socket.drop();
    expect(c.current.messages[0]).toMatchObject({ undelivered: true });
    expect(c.current.connected).toBe(false);
  });

  it("is not delivered when the hub comes back without the turn it had (it restarted)", async () => {
    const { c, socket } = await open();
    const lost = say(c, socket, "deploy it");
    socket.receive({ type: "typing", turn_ref: lost.ref, id: "r1" });
    socket.drop();
    expect(c.current.messages[0]!.undelivered).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    const again = FakeSocket.find("/ws", "atlas")!;
    await Promise.resolve();
    expect(again).not.toBe(socket);
    expect(c.current.connected).toBe(true);
    await wait(again, RECONNECT_GRACE_MS + 1_000);
    expect(c.current.messages[0]).toMatchObject({ undelivered: true });
  });

  it("stays delivered when the hub comes back still running it", async () => {
    const { c, socket } = await open();
    const going = say(c, socket, "deploy it");
    socket.receive({ type: "typing", turn_ref: going.ref, id: "r1" });
    socket.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    const again = FakeSocket.find("/ws", "atlas")!;
    await Promise.resolve();
    again.receive({ type: "turn_snapshot", turn_ref: going.ref, id: "r1", status: "working", text: "" });
    await wait(again, RECONNECT_GRACE_MS + 1_000);
    expect(c.current.messages[0]!.undelivered).toBeUndefined();
    expect(c.current.turns[going.ref]!.state).toBe("live");
  });

  it("is refused plainly when the agent is busy, and can be sent again", async () => {
    const { c, socket } = await open();
    const { ref } = say(c, socket, "deploy it");
    socket.receive({ type: "error", turn_ref: ref, content: "busy" });
    expect(c.current.messages[0]).toMatchObject({ undelivered: true });
  });
});

describe("the / menu's commands", () => {
  const commands: HubCommand[] = [
    { name: "new", args: "[model]", aliases: ["n"], summary: "Start a fresh session" },
    { name: "reset", args: "", aliases: ["r", "clear"], summary: "Clear session history" },
    { name: "status", args: "", aliases: ["s"], summary: "Show session info" },
    { name: "skills", args: "", aliases: [], summary: "List the agent's skills" },
  ];
  it("are those the start of the box names, by name first, then by alias", () => {
    expect(matching("/", commands).map((c) => c.name)).toEqual(["new", "reset", "status", "skills"]);
    expect(matching("/s", commands).map((c) => c.name)).toEqual(["status", "skills"]);
    expect(matching("/cl", commands).map((c) => c.name)).toEqual(["reset"]);
    expect(matching("/status now", commands)).toEqual([]);
    expect(matching("hello /s", commands)).toEqual([]);
  });
});

describe("a command's answer", () => {
  it("keeps the hub's lines and reads its *bold* as bold, leaving code alone", () => {
    expect(commandMarkdown("📊 *Session Status*\n\n  Session: `desk:*a*`\n  Model: x")).toBe(
      "📊 **Session Status**  \n  \n  Session: `desk:*a*`  \n  Model: x",
    );
    expect(commandMarkdown("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(commandMarkdown("**already**")).toBe("**already**");
  });
});
