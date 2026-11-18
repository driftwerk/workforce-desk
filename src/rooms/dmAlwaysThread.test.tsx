import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../testing/sockets";

// "Always reply in a thread": each new message you send in the DM starts a
// thread on itself, and the agent answers there, as in Slack. The DM reads
// as the list of those conversations.

const kept = vi.hoisted(() => ({ state: new Map<string, unknown>() }));
vi.mock("../restore/boot", () => ({
  deskState: {
    get: (k: string) => kept.state.get(k),
    set: (k: string, v: unknown) => void kept.state.set(k, v),
    setSoon: (k: string, v: unknown) => void kept.state.set(k, v),
    remove: (k: string) => void kept.state.delete(k),
    watch: () => () => {},
    loaded: Promise.resolve(),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
  emitTo: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useReads } = await import("../unread/reads");
const { useSettings } = await import("../settings/store");
const { useUi } = await import("../shell/ui");
const { Rooms } = await import("./Rooms");

Element.prototype.scrollIntoView = () => {};

const KEY = "dw/allan";
const THREADS = ["desk.place", "desk.stream", "desk.queue", "desk.client_ids", "desk.edit", "desk.dm_threads", "desk.thread_starts"];
const history = [{ id: "k0", from: "assistant", text: "Morning. Anything for me?", at: "2026-11-10T09:00:00Z" }];

const open = async (features = THREADS) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("/threads")
        ? new Response(JSON.stringify({ threads: [] }), { headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ messages: String(url).includes("channel=") ? [] : history, more: false }), {
            headers: { "content-type": "application/json" },
          }),
    ),
  );
  render(<Rooms />);
  act(() => useChat.getState().openDm(KEY));
  await vi.waitFor(() => expect(FakeSocket.find("/ws", "allan", "desk")).toBeDefined());
  const s = FakeSocket.find("/ws", "allan", "desk")!;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    s.receive({ type: "connected", session_id: "s-allan", features });
  });
  await vi.waitFor(() => expect(screen.getByText("Morning. Anything for me?")).toBeTruthy());
  return s;
};

const send = (placeholder: string, text: string) => {
  const box = screen.getByPlaceholderText(placeholder);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
};

const threadSockets = () => FakeSocket.opened.filter((s) => s.query.get("channel")?.startsWith("desk:thread:"));

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.reset();
  kept.state.clear();
  useDesk.setState({ view: "rooms", activeRoom: null, inbox: false, hub: null });
  for (const key of Object.keys(useChat.getState().conversations)) useChat.getState().forget(key);
  useChat.setState({
    hubs: [{ id: "dw", label: "Acme", url: "https://acme.example.com", local: false, revision: "t" }],
    roster: [{ hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
    rosterRead: true,
    queues: {},
    histories: {},
    starting: {},
  });
  useSettings.setState({ loaded: false, threadReplies: [] });
  useUi.setState({ dmThreads: {} });
  useReads.setState({ local: {}, dms: {}, loaded: true });
});
afterEach(cleanup);

describe("Always reply in a thread", () => {
  it("is a choice in the chat's ⋯ menu where the hub starts threads", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "More for Allan" }));
    const item = screen.getByRole("menuitemcheckbox", { name: /Always reply in a thread/ });
    expect(item.getAttribute("aria-checked")).toBe("false");
    act(() => fireEvent.click(item));
    expect(useSettings.getState().threadReplies).toEqual([KEY]);
    expect(screen.getByPlaceholderText("Start a thread with Allan")).toBeTruthy();
  });

  it("isn't offered where the hub has no way to start one", async () => {
    await open(THREADS.filter((f) => f !== "desk.thread_starts"));
    expect(screen.queryByRole("button", { name: "More for Allan" })?.classList.contains("composer-more-kept")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "More for Allan" }));
    expect(screen.queryByRole("menuitemcheckbox", { name: /Always reply in a thread/ })).toBeNull();
  });

  it("starts a thread on each new message, answered there, and opens it", async () => {
    useSettings.setState({ threadReplies: [KEY] });
    const dm = await open();
    act(() => send("Start a thread with Allan", "what's on today?"));
    await vi.waitFor(() => expect(threadSockets()).toHaveLength(1));
    const thread = threadSockets()[0]!;
    const parent = thread.query.get("channel")!.slice("desk:thread:".length);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      thread.receive({ type: "connected", session_id: "s-thread", features: THREADS });
      await new Promise((r) => setTimeout(r, 200));
    });
    await vi.waitFor(() => expect(thread.chats).toHaveLength(1));
    expect(thread.chats[0]).toMatchObject({ content: "what's on today?", desk: { place: { kind: "dm", thread: parent }, message: parent, starts_thread: true } });
    expect(dm.chats).toHaveLength(0);
    // In the chat at once, as a conversation of its own, opened beside it.
    const row = screen.getByText("what's on today?").closest(".room-msg")!;
    expect(row.classList.contains("thread-start")).toBe(true);
    expect(useUi.getState().dmThreads[KEY]).toBe(parent);
    expect(row.querySelector(".msg-actions")?.textContent ?? "").not.toMatch(/Edit|Reply in thread/);
  });

  it("starts another for the next one, without waiting on the first", async () => {
    useSettings.setState({ threadReplies: [KEY] });
    await open();
    act(() => send("Start a thread with Allan", "one"));
    act(() => send("Start a thread with Allan", "two"));
    await vi.waitFor(() => expect(threadSockets()).toHaveLength(2));
    expect(new Set(threadSockets().map((s) => s.query.get("channel"))).size).toBe(2);
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("sends in the chat as before when it's off", async () => {
    const dm = await open();
    act(() => send("Message Allan", "hello"));
    expect(dm.chats).toHaveLength(1);
    expect(threadSockets()).toHaveLength(0);
  });
});
