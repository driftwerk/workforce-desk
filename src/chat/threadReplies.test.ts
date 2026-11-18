import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyConversation } from "./conversation";
import { fromHub } from "./history";
import { turnOf, useChat } from "./store";
import { canStartThreads, isCommand, setRepliesInThreads } from "./threadReplies";
import type { Agent, DeskTurn, HubAccount } from "./types";
import { useSettings } from "../settings/store";

/** What each conversation opened sent, by the key it was opened for. */
const sent = vi.hoisted(() => ({ calls: [] as { agent: unknown; channel?: string; text: string; turn?: DeskTurn }[], ready: true }));

vi.mock("./conversation", async (original) => ({
  ...(await original<typeof import("./conversation")>()),
  Conversation: class {
    constructor(
      _hub: unknown,
      readonly agent: unknown,
      _change: unknown,
      readonly channel?: string,
    ) {}
    send(text: string, ask: { turn?: DeskTurn }) {
      if (!sent.ready) return false;
      sent.calls.push({ agent: this.agent, channel: this.channel, text, turn: ask.turn });
      return { turnRef: "t1" };
    }
    forget() {}
    drop() {}
    place() {}
    unkeep() {}
    remove() {}
    restore() {}
    cancel() {}
    close() {}
  },
}));
vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  saveSettings: vi.fn(() => Promise.resolve()),
}));

const hub: HubAccount = { id: "acme", label: "Acme", url: "https://hub.example.com", local: false, revision: "t" };
const agent: Agent = { hubId: "acme", id: "scout", name: "Scout", model: null, provider: null, isDefault: false };
const key = "acme/scout";

beforeEach(() => {
  sent.calls = [];
  sent.ready = true;
  useChat.setState({ hubs: [hub], roster: [agent], conversations: { [key]: emptyConversation() }, histories: {}, threads: {}, starting: {}, queues: {} });
});
afterEach(() => useChat.getState().forget(key));

describe("Always reply in a thread", () => {
  it("is offered only where the hub starts threads on new messages", () => {
    expect(canStartThreads(new Set(["desk.dm_threads", "desk.thread_starts"]))).toBe(true);
    expect(canStartThreads(new Set(["desk.dm_threads"]))).toBe(false);
    expect(canStartThreads(undefined)).toBe(false);
  });

  it("is kept per agent with Desk's settings", () => {
    useSettings.setState({ loaded: true, threadReplies: ["acme/other"] });
    setRepliesInThreads(key, true);
    expect(useSettings.getState().threadReplies).toEqual(["acme/other", key]);
    setRepliesInThreads(key, false);
    expect(useSettings.getState().threadReplies).toEqual(["acme/other"]);
  });

  it("leaves the hub's commands in the chat they are typed in", () => {
    const commands = [{ name: "/status", aliases: ["st"] }, { name: "model", aliases: [] }];
    expect(isCommand("/status", commands)).toBe(true);
    expect(isCommand("  /st now", commands)).toBe(true);
    expect(isCommand("/model opus", commands)).toBe(true);
    expect(isCommand("/usr/bin is where?", commands)).toBe(false);
    expect(isCommand("what's /status?", commands)).toBe(false);
  });
});

describe("A new message that starts its own thread", () => {
  it("is sent in the thread on itself, under its own id, and shows in the chat at once", async () => {
    const id = await useChat.getState().startThread(key, "what shall we ship?");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const [call] = sent.calls;
    expect(call?.channel).toBe(`desk:thread:${id}`);
    expect(call?.text).toBe("what shall we ship?");
    expect(call?.turn).toMatchObject({ place: { kind: "dm", thread: id }, message: id, starts_thread: true, context: [] });
    expect(useChat.getState().starting[key]).toEqual([expect.objectContaining({ id, clientId: id, role: "user", startsThread: true })]);
  });

  it("carries no chat into its thread's later turns, which begin with it", async () => {
    const id = (await useChat.getState().startThread(key, "first"))!;
    useChat.setState({ starting: {} });
    useChat.setState({
      histories: {
        [key]: { state: "ready", messages: [fromHub({ id, from: "user", text: "first", client_id: id, mark: { starts_thread: true } })], more: false, earlier: "idle", loadedAt: null },
      },
    });
    const later = turnOf(`${key}#${id}`);
    expect(later.context).toEqual([]);
    expect(later.starts_thread).toBeUndefined();
    // A reply in it is no start: it is sent under an id of its own.
    sent.calls = [];
    useChat.getState().send(`${key}#${id}`, "and then?");
    expect(sent.calls[0]?.turn?.starts_thread).toBeUndefined();
  });

  it("is taken back when its thread can't be reached", async () => {
    vi.useFakeTimers();
    sent.ready = false;
    const started = useChat.getState().startThread(key, "hello?");
    await vi.runAllTimersAsync();
    expect(await started).toBeNull();
    expect(useChat.getState().starting[key]).toEqual([]);
    vi.useRealTimers();
  });

  it("is never started from inside a thread", async () => {
    expect(await useChat.getState().startThread(`${key}#p`, "nested")).toBeNull();
    expect(sent.calls).toEqual([]);
  });
});
