import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../testing/sockets";

// Typing while an agent works, in a DM: the message waits in a queue under
// the composer for the next turn, Esc or Stop stops the turn, and a queued
// message can be sent at once.

const kept = vi.hoisted(() => ({
  state: new Map<string, unknown>(),
  watchers: new Map<string, Set<(v: unknown) => void>>(),
  loaded: Promise.resolve() as Promise<void>,
}));
const state = kept.state;
vi.mock("../restore/boot", () => ({
  deskState: {
    get: (k: string) => kept.state.get(k),
    set: (k: string, v: unknown) => void kept.state.set(k, v),
    setSoon: (k: string, v: unknown) => void kept.state.set(k, v),
    remove: (k: string) => void kept.state.delete(k),
    watch: (k: string, f: (v: unknown) => void) => {
      const set = kept.watchers.get(k) ?? new Set();
      set.add(f);
      kept.watchers.set(k, set);
      return () => set.delete(f);
    },
    get loaded() {
      return kept.loaded;
    },
  },
}));

/** Another window (through the hub) changes what's kept under `key`. */
const elsewhere = (key: string, value: unknown) =>
  act(() => {
    kept.state.set(key, value);
    for (const f of kept.watchers.get(key) ?? []) f(value);
  });
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));

const { useChat, STREAM_END_GRACE_MS } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { Rooms } = await import("./Rooms");

Element.prototype.scrollIntoView = () => {};

const KEY = "dw/allan";
const FEATURES = ["desk.place", "desk.stream", "desk.queue"];

const connect = async (features = FEATURES) => {
  await vi.waitFor(() => expect(FakeSocket.find("/ws", "allan")).toBeDefined());
  const s = FakeSocket.find("/ws", "allan")!;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    s.receive({ type: "connected", session_id: "s-allan", features });
  });
  return s;
};

const box = () => screen.getByPlaceholderText("Message Allan") as HTMLTextAreaElement;

const type = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: "Enter" });
};

const queued = () => [...document.querySelectorAll(".queued-text")].map((e) => e.textContent);

/** Opens the DM and starts a turn the hub is working on. */
const working = async (features = FEATURES) => {
  render(<Rooms />);
  act(() => useChat.getState().openDm(KEY));
  const s = await connect(features);
  act(() => type("check the deploy"));
  const ref = s.chats[0]!.turn_ref as string;
  act(() => s.receive({ type: "typing", session_id: "s-allan", turn_ref: ref }));
  return { s, ref };
};

const ends = (s: FakeSocket, ref: string) =>
  act(async () => {
    s.receive({ type: "stream_start", session_id: "s-allan", turn_ref: ref, id: `a-${ref}` });
    s.receive({ type: "stream_end", session_id: "s-allan", turn_ref: ref });
    s.receive({ type: "turn_end", session_id: "s-allan", turn_ref: ref, id: `a-${ref}` });
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ messages: [], more: false }), { headers: { "content-type": "application/json" } })),
  );
  FakeSocket.reset();
  state.clear();
  kept.loaded = Promise.resolve();
  useDesk.setState({ view: "rooms", activeRoom: null, inbox: false, hub: null });
  for (const key of Object.keys(useChat.getState().conversations)) useChat.getState().forget(key);
  useChat.setState({
    hubs: [{ id: "dw", label: "Acme", url: "https://acme.example.com", local: false, revision: "t" }],
    roster: [{ hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
    rosterRead: true,
    queues: {},
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("typing while an agent works", () => {
  it("queues what you send under the composer instead of steering the turn", async () => {
    const { s } = await working();
    act(() => type("and the staging one"));
    act(() => type("then tell me"));
    expect(s.chats).toHaveLength(1);
    expect(queued()).toEqual(["and the staging one", "then tell me"]);
    expect(screen.getByText("2 messages queued. They go together when Allan’s done.")).toBeTruthy();
    expect(box().value).toBe("");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
  });

  it("sends everything queued as the next turn, merged in order, once the turn ends", async () => {
    const { s, ref } = await working();
    act(() => type("and the staging one"));
    act(() => type("then tell me"));
    await ends(s, ref);
    expect(s.chats).toHaveLength(2);
    expect(s.chats[1]).toMatchObject({ content: "and the staging one\n\nthen tell me", mode: "queue" });
    // Kept, on its way, until the hub takes it.
    expect(queued()).toEqual(["and the staging one", "then tell me"]);
    expect(screen.getAllByText("Sending…")).toHaveLength(2);
    act(() => s.receive({ type: "typing", session_id: "s-allan", turn_ref: s.chats[1]!.turn_ref }));
    expect(queued()).toEqual([]);
    expect(state.has(`draft.queue.${KEY}`)).toBe(false);
  });

  it("asks a hub that doesn't know queueing as before, once the turn ends", async () => {
    const { s, ref } = await working(["desk.place", "desk.stream"]);
    act(() => type("and staging"));
    await ends(s, ref);
    expect(s.chats[1]).toMatchObject({ content: "and staging" });
    expect(s.chats[1]).not.toHaveProperty("mode");
  });

  it("lets a queued message be edited or taken out while it waits", async () => {
    const { s, ref } = await working();
    act(() => type("and the staging one"));
    act(() => type("then tell me"));
    const [first, second] = screen.getAllByRole("listitem");
    fireEvent.click(within(first!).getByRole("button", { name: "Edit queued message" }));
    const edit = within(first!).getByRole("textbox", { name: "Edit queued message" });
    fireEvent.change(edit, { target: { value: "and prod" } });
    fireEvent.keyDown(edit, { key: "Enter" });
    fireEvent.click(within(second!).getByRole("button", { name: "Remove queued message" }));
    expect(queued()).toEqual(["and prod"]);
    await ends(s, ref);
    expect(s.chats[1]).toMatchObject({ content: "and prod", mode: "queue" });
  });

  it("sends a queued message now, into the running turn", async () => {
    const { s } = await working();
    act(() => type("stop after the first check"));
    act(() => type("then tell me"));
    fireEvent.click(within(screen.getAllByRole("listitem")[0]!).getByRole("button", { name: "Send now" }));
    expect(s.chats).toHaveLength(2);
    expect(s.chats[1]).toMatchObject({ content: "stop after the first check" });
    expect(s.chats[1]).not.toHaveProperty("mode");
    expect(queued()).toEqual(["then tell me"]);
  });

  it("stops the turn on Esc, and what's queued then waits until you send it", async () => {
    const { s, ref } = await working();
    act(() => type("and staging"));
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    act(() => void box().dispatchEvent(esc));
    document.removeEventListener("keydown", outer);
    expect(s.sent.filter((m) => m.type === "cancel")).toHaveLength(1);
    expect(outer).not.toHaveBeenCalled();
    // The stopped turn ends silently; nothing goes on its own.
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(s.chats).toHaveLength(1);
    expect(screen.getByText("1 message waiting. It won’t go on its own.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send it" }));
    expect(s.chats[1]).toMatchObject({ content: "and staging", mode: "queue" });
    void ref;
  });

  it("stops the turn with the Stop button, pausing the queue the same way", async () => {
    const { s } = await working();
    act(() => type("and staging"));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(s.sent.filter((m) => m.type === "cancel")).toHaveLength(1);
    expect(s.chats).toHaveLength(1);
    expect(queued()).toEqual(["and staging"]);
  });

  it("holds what's queued after a Stop, and what you queue behind it, until you send it on", async () => {
    const { s } = await working();
    act(() => type("and staging"));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    // You ask something else; while it's answered you queue one more.
    act(() => type("what failed?"));
    const ref = s.chats[1]!.turn_ref as string;
    expect(s.chats[1]).toMatchObject({ content: "what failed?" });
    act(() => s.receive({ type: "typing", session_id: "s-allan", turn_ref: ref }));
    act(() => type("and prod"));
    await ends(s, ref);
    expect(s.chats).toHaveLength(2);
    expect(queued()).toEqual(["and staging", "and prod"]);
    fireEvent.click(screen.getByRole("button", { name: "Send them" }));
    expect(s.chats[2]).toMatchObject({ content: "and staging\n\nand prod", mode: "queue" });
  });

  it("leaves Esc alone when nothing is running", async () => {
    render(<Rooms />);
    act(() => useChat.getState().openDm(KEY));
    const s = await connect();
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void box().dispatchEvent(esc));
    expect(esc.defaultPrevented).toBe(false);
    expect(s.sent.filter((m) => m.type === "cancel")).toHaveLength(0);
  });

  it("takes a queued send back, quietly, when the hub says a turn is still running", async () => {
    const { s, ref } = await working();
    act(() => type("and staging"));
    await ends(s, ref);
    const sent = s.chats[1]!;
    vi.useFakeTimers();
    act(() => s.receive({ type: "error", session_id: "s-allan", turn_ref: sent.turn_ref, content: "busy" }));
    expect(queued()).toEqual(["and staging"]);
    expect(screen.queryByText(/Send this again/)).toBeNull();
    expect([...document.querySelectorAll(".msg-text")].map((e) => e.textContent?.trim())).not.toContain("and staging");
    act(() => vi.advanceTimersByTime(3000 + 10));
    expect(s.chats).toHaveLength(3);
    expect(s.chats[2]).toMatchObject({ content: "and staging", mode: "queue" });
    // Held back again: it waits twice as long each time, up to a minute.
    act(() => s.receive({ type: "error", session_id: "s-allan", turn_ref: s.chats[2]!.turn_ref, content: "busy" }));
    act(() => vi.advanceTimersByTime(3000 + 10));
    expect(s.chats).toHaveLength(3);
    act(() => vi.advanceTimersByTime(3000));
    expect(s.chats).toHaveLength(4);
  });

  it("keeps the queue through a reload, paused", async () => {
    const { s } = await working();
    act(() => type("and staging"));
    expect(state.get(`draft.queue.${KEY}`)).toMatchObject({ items: [{ text: "and staging" }] });
    // The window reloads: a fresh conversation reads the queue back.
    cleanup();
    s.drop();
    act(() => useChat.getState().forget(KEY));
    state.set(`draft.queue.${KEY}`, { items: [{ id: "q1", text: "and staging" }] });
    useChat.setState({ queues: {} });
    render(<Rooms />);
    act(() => useChat.getState().openDm(KEY));
    const again = await connect();
    expect(queued()).toEqual(["and staging"]);
    expect(again.chats).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Send it" }));
    expect(again.chats[0]).toMatchObject({ content: "and staging", mode: "queue" });
  });

  /** Queues "and staging" behind a turn, lets the turn end, and returns the
   *  queued send that went. */
  const sentFromQueue = async () => {
    const w = await working();
    act(() => type("and staging"));
    await ends(w.s, w.ref);
    return { ...w, sent: w.s.chats[1]! };
  };

  const said = () => [...document.querySelectorAll(".msg-text")].map((e) => e.textContent?.trim());

  for (const why of [
    "Server is shutting down — please reconnect",
    "Access denied: device does not have 'chat' scope",
    "Agent error: no route to the agent",
  ])
    it(`puts a queued send back, paused, when the hub refuses it: ${why}`, async () => {
      const { s, sent } = await sentFromQueue();
      act(() => s.receive({ type: "error", session_id: "s-allan", turn_ref: sent.turn_ref, content: why }));
      expect(queued()).toEqual(["and staging"]);
      expect(screen.queryByText("Sending…")).toBeNull();
      expect(screen.getByText("1 message waiting. It won’t go on its own.")).toBeTruthy();
      expect(said()).not.toContain("and staging");
      expect(state.get(`draft.queue.${KEY}`)).toMatchObject({ items: [{ text: "and staging" }] });
      expect(s.chats).toHaveLength(2);
    });

  it("puts a queued send back, paused, when the connection drops before the hub answers", async () => {
    const { s } = await sentFromQueue();
    act(() => s.drop());
    expect(queued()).toEqual(["and staging"]);
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(useChat.getState().queues[KEY]!.paused).toBe(true);
  });

  it("puts back what was on its way when the window reloaded before the hub answered", async () => {
    const { s } = await sentFromQueue();
    expect(state.get(`draft.queue.${KEY}`)).toMatchObject({ items: [{ text: "and staging", sending: expect.any(String) }] });
    const keptThen = state.get(`draft.queue.${KEY}`);
    cleanup();
    s.drop();
    act(() => useChat.getState().forget(KEY));
    state.set(`draft.queue.${KEY}`, keptThen);
    useChat.setState({ queues: {} });
    render(<Rooms />);
    act(() => useChat.getState().openDm(KEY));
    const again = await connect();
    expect(queued()).toEqual(["and staging"]);
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(again.chats).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Send it" }));
    expect(again.chats[0]).toMatchObject({ content: "and staging", mode: "queue" });
  });

  it("never leaves a queue waiting on a turn that never says it ended", async () => {
    const { s, ref } = await working();
    act(() => type("and staging"));
    vi.useFakeTimers();
    await act(async () => {
      s.receive({ type: "stream_start", session_id: "s-allan", turn_ref: ref, id: `a-${ref}` });
      s.receive({ type: "stream_end", session_id: "s-allan", turn_ref: ref });
    });
    // No turn_end: Stop and Send now stay, and the queue goes after a grace.
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send now" })).toBeTruthy();
    expect(s.chats).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(STREAM_END_GRACE_MS + 50));
    expect(s.chats).toHaveLength(2);
    expect(s.chats[1]).toMatchObject({ content: "and staging", mode: "queue" });
  });

  it("sends what an edit says when the turn ends mid-edit, once it's saved", async () => {
    const { s, ref } = await working();
    act(() => type("and staging"));
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    const edit = screen.getByRole("textbox", { name: "Edit queued message" });
    fireEvent.change(edit, { target: { value: "and prod" } });
    await ends(s, ref);
    expect(s.chats).toHaveLength(1);
    fireEvent.keyDown(edit, { key: "Enter" });
    expect(s.chats).toHaveLength(2);
    expect(s.chats[1]).toMatchObject({ content: "and prod", mode: "queue" });
  });

  it("leaves Esc to the input method while it's composing", async () => {
    const { s } = await working();
    fireEvent.keyDown(box(), { key: "Escape", isComposing: true });
    fireEvent.keyDown(box(), { key: "Escape", keyCode: 229 });
    expect(s.sent.filter((m) => m.type === "cancel")).toHaveLength(0);
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(s.sent.filter((m) => m.type === "cancel")).toHaveLength(1);
  });

  it("doesn't send what another window already sent", async () => {
    const { s, ref } = await working();
    act(() => type("and staging"));
    const [item] = useChat.getState().queues[KEY]!.items;
    // The other window has it on its way: this one holds off.
    elsewhere(`draft.queue.${KEY}`, { items: [{ ...item, sending: "elsewhere" }] });
    await ends(s, ref);
    expect(s.chats).toHaveLength(1);
    expect(screen.getByText("Sending…")).toBeTruthy();
    // The hub took it there: it's gone here too.
    elsewhere(`draft.queue.${KEY}`, null);
    expect(queued()).toEqual([]);
    expect(s.chats).toHaveLength(1);
  });

  it("keeps what Desk's file holds when it's read after the window opened", async () => {
    let read = () => {};
    kept.loaded = new Promise<void>((done) => (read = done));
    const { s } = await working();
    act(() => type("and prod"));
    state.set(`draft.queue.${KEY}`, { items: [{ id: "q0", text: "and staging" }, ...useChat.getState().queues[KEY]!.items] });
    await act(async () => read());
    expect(queued()).toEqual(["and staging", "and prod"]);
    expect(useChat.getState().queues[KEY]!.paused).toBe(true);
    expect(s.chats).toHaveLength(1);
  });
});
