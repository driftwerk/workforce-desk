import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../testing/sockets";

// Deleting a message of yours from a DM, confirmed in place: what the agent
// saved from it is listed, to forget too; the message goes from the chat
// and the agent's history, and the reply to it stays, marked as answering
// a deleted message. A queued message is deleted by taking it out of the
// queue, and nothing reaches the hub.

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
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useReads } = await import("../unread/reads");
const { Rooms } = await import("./Rooms");

Element.prototype.scrollIntoView = () => {};

const KEY = "dw/allan";
const FEATURES = ["desk.place", "desk.stream", "desk.queue", "desk.client_ids", "desk.edit", "desk.delete"];
const at = (min: number) => new Date(Date.parse("2026-11-10T09:00:00Z") + min * 60_000).toISOString();

/** You asked to file a bug; Allan's reply filed and assigned it. */
const history = [
  { id: "k0", from: "assistant", text: "Want me to file the leads bug?", at: at(0) },
  { id: "k1", from: "user", text: "the staging password is on the old wiki page", at: at(1), client_id: "c1" },
  {
    id: "k2",
    from: "assistant",
    text: "Filed ATL-571 and assigned it to Sam Lee.",
    at: at(2),
  },
];

/** What the hub was asked, by method and path. */
let asked: { method: string; path: string; body: unknown }[] = [];
let refuse: string | null = null;
/** The status the hub's DELETE answers with, and whether its memories read fails. */
let status = 200;
let memoriesFail = false;
/** What the hub's read returns: after a delete, without the message, and
 *  its reply marked. */
let read: object[] = history;
const MEMORY = { id: "mem-1", text: "staging password is on the old wiki page" };

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
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const open = async (features = FEATURES) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = init?.method ?? "GET";
      asked.push({ method, path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u.pathname.endsWith("/memories")) return memoriesFail ? json({ error: "no" }, 503) : json({ memories: [MEMORY] });
      if (method === "DELETE") {
        if (refuse) return json({ error: refuse }, 409);
        if (status !== 200) return json({ error: "message not found" }, status);
        read = [history[0]!, { ...history[2]!, mark: { answered_deleted: true } }];
        return json({ deleted: true, forgot: [] });
      }
      return json({ messages: read, more: false });
    }),
  );
  render(<Rooms />);
  act(() => useChat.getState().openDm(KEY));
  const s = await connect(features);
  await vi.waitFor(() => expect(screen.getByText("Filed ATL-571 and assigned it to Sam Lee.")).toBeTruthy());
  return s;
};

const rowOf = (text: string) => screen.getByText(text).closest(".room-msg") as HTMLElement;
const deletes = () => asked.filter((a) => a.method === "DELETE");

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.reset();
  kept.state.clear();
  asked = [];
  refuse = null;
  status = 200;
  memoriesFail = false;
  read = history;
  useDesk.setState({ view: "rooms", activeRoom: null, inbox: false, hub: null });
  for (const key of Object.keys(useChat.getState().conversations)) useChat.getState().forget(key);
  useChat.setState({
    hubs: [{ id: "dw", label: "Acme", url: "https://acme.example.com", local: false, revision: "t" }],
    roster: [{ hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
    rosterRead: true,
    queues: {},
    histories: {},
    setAside: {},
    orphans: {},
  });
  useReads.setState({ local: {}, dms: {}, loaded: true });
});
afterEach(cleanup);

describe("deleting your message", () => {
  it("is confirmed in place, forgets what was saved from it, and leaves the reply marked", async () => {
    await open();
    fireEvent.click(within(rowOf("the staging password is on the old wiki page")).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("group", { name: "Delete this message?" });
    const forget = await within(confirm).findByRole("checkbox");
    expect((forget as HTMLInputElement).checked).toBe(true);
    expect(confirm.textContent).toContain("“staging password is on the old wiki page”");
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
    expect(deletes()).toEqual([{ method: "DELETE", path: "/api/desk/conversations/allan/messages/k1", body: { forget: ["mem-1"] } }]);
    expect(screen.queryByText("the staging password is on the old wiki page")).toBeNull();
    expect(rowOf("Filed ATL-571 and assigned it to Sam Lee.").textContent).toContain("Answered a deleted message");
    // The hub's read leaves it out and marks the reply: what Desk guessed goes.
    await vi.waitFor(() => expect(useChat.getState().orphans[KEY]).toEqual([]));
    expect(screen.queryByText("the staging password is on the old wiki page")).toBeNull();
    expect(rowOf("Filed ATL-571 and assigned it to Sam Lee.").textContent).toContain("Answered a deleted message");
  });

  it("takes a message the hub has already lost as deleted", async () => {
    await open();
    status = 404;
    fireEvent.click(within(rowOf("the staging password is on the old wiki page")).getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("group", { name: "Delete this message?" });
    await within(confirm).findByRole("checkbox");
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
    await vi.waitFor(() => expect(screen.queryByText("the staging password is on the old wiki page")).toBeNull());
    expect(screen.queryByRole("group", { name: "Delete this message?" })).toBeNull();
  });

  it("says so when what was saved from it can't be checked, and still deletes", async () => {
    await open();
    memoriesFail = true;
    fireEvent.click(within(rowOf("the staging password is on the old wiki page")).getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("group", { name: "Delete this message?" });
    await vi.waitFor(() => expect(confirm.textContent).toContain("Couldn’t check what Allan saved from it"));
    expect(within(confirm).queryByRole("checkbox")).toBeNull();
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
    expect(deletes()[0]!.body).toEqual({ forget: [] });
  });

  it("closes the confirm when ↑ opens the edit of the same message", async () => {
    await open();
    fireEvent.click(within(rowOf("the staging password is on the old wiki page")).getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("group", { name: "Delete this message?" })).toBeTruthy();
    act(() => void fireEvent.keyDown(box(), { key: "ArrowUp" }));
    expect(screen.getByRole("form", { name: "Editing your last message" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Delete this message?" })).toBeNull();
  });

  it("keeps the memories when you untick them, and Cancel deletes nothing", async () => {
    await open();
    const mine = () => rowOf("the staging password is on the old wiki page");
    fireEvent.click(within(mine()).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Delete this message?" })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Delete this message?" })).toBeNull();
    expect(deletes()).toEqual([]);
    fireEvent.click(within(mine()).getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("group", { name: "Delete this message?" });
    fireEvent.click(await within(confirm).findByRole("checkbox"));
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
    expect(deletes()[0]!.body).toEqual({ forget: [] });
  });

  it("says what the hub refused, and keeps the message", async () => {
    await open();
    refuse = "Allan is answering in this conversation right now.";
    fireEvent.click(within(rowOf("the staging password is on the old wiki page")).getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("group", { name: "Delete this message?" });
    await within(confirm).findByRole("checkbox");
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
    await vi.waitFor(() => expect(confirm.textContent).toContain("Allan is answering"));
    expect(screen.getByText("the staging password is on the old wiki page")).toBeTruthy();
  });

  it("offers no Delete on the agent's messages, nor on a hub that can't", async () => {
    await open();
    expect(within(rowOf("Filed ATL-571 and assigned it to Sam Lee.")).queryByRole("button", { name: "Delete" })).toBeNull();
    cleanup();
    for (const key of Object.keys(useChat.getState().conversations)) useChat.getState().forget(key);
    FakeSocket.reset();
    await open(FEATURES.filter((f) => f !== "desk.delete"));
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("deleting with the queue", () => {
  it("says why not while the agent is replying, and queued messages stay", async () => {
    const s = await open();
    act(() => type("check the deploy"));
    act(() => s.receive({ type: "typing", session_id: "s-allan", turn_ref: s.chats[0]!.turn_ref }));
    act(() => type("and staging"));
    fireEvent.click(within(rowOf("the staging password is on the old wiki page")).getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("group", { name: "Delete this message?" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("You can delete a message once Allan has finished replying.");
    expect(queued()).toEqual(["and staging"]);
  });

  it("deletes an earlier message while queued messages wait, and leaves the queue as it was", async () => {
    const s = await open();
    act(() => type("check the deploy"));
    const ref = s.chats[0]!.turn_ref as string;
    act(() => s.receive({ type: "typing", session_id: "s-allan", turn_ref: ref }));
    act(() => type("and staging"));
    // Stopped: the turn ends, and the queue waits, paused.
    act(() => useChat.getState().cancel(KEY));
    await act(async () => {
      s.receive({ type: "turn_end", session_id: "s-allan", turn_ref: ref });
      await new Promise((r) => setTimeout(r, 0));
    });
    const before = useChat.getState().queues[KEY];
    fireEvent.click(within(rowOf("the staging password is on the old wiki page")).getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("group", { name: "Delete this message?" });
    await within(confirm).findByRole("checkbox");
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
    expect(deletes()).toHaveLength(1);
    await vi.waitFor(() => expect(screen.queryByText("the staging password is on the old wiki page")).toBeNull());
    expect(useChat.getState().queues[KEY]).toEqual(before);
    expect(queued()).toEqual(["and staging"]);
    expect(s.chats).toHaveLength(1);
  });

  it("takes a queued message out of the queue, and nothing reaches the hub", async () => {
    const s = await open();
    act(() => type("check the deploy"));
    act(() => s.receive({ type: "typing", session_id: "s-allan", turn_ref: s.chats[0]!.turn_ref }));
    act(() => type("and staging"));
    act(() => type("then tell me"));
    fireEvent.click(within(screen.getAllByRole("listitem")[0]!).getByRole("button", { name: "Remove queued message" }));
    expect(queued()).toEqual(["then tell me"]);
    expect(deletes()).toEqual([]);
    expect(s.chats).toHaveLength(1);
  });
});
