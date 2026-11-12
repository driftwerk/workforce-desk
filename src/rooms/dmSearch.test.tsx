import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../testing/sockets";

// ⌘F searches a DM's whole history on the hub. Matches are listed beside
// the chat, newest first; choosing one shows the chat around it, read from
// the hub when it isn't loaded, until Jump to latest. The queue goes on as
// before while you search.

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
const FEATURES = ["desk.place", "desk.stream", "desk.queue", "desk.client_ids", "desk.edit", "desk.delete", "desk.search"];
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

let asked: { method: string; path: string; query: URLSearchParams }[] = [];
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
const OLD = [
  { id: "o1", from: "user", text: "start a session to move atlas onto ledger", at: at(-600) },
  { id: "o2", from: "assistant", text: "Started Ledger Migration in the atlas monorepo.", at: at(-599) },
];

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

const open = async (features = FEATURES) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      asked.push({ method: "GET", path: u.pathname, query: u.searchParams });
      if (u.pathname.endsWith("/search"))
        return json({
          matches: [
            { id: "k2", from: "agent", at: at(2), excerpt: "Filed ATL-571 and assigned it to Sam Lee." },
            { id: "o2", from: "agent", at: at(-599), excerpt: "Started Ledger Migration in the atlas monorepo." },
          ],
          more: false,
        });
      if (u.searchParams.get("around")) return json({ messages: OLD, more: false, more_after: true });
      return json({ messages: history, more: false });
    }),
  );
  render(<Rooms />);
  act(() => useChat.getState().openDm(KEY));
  const s = await connect(features);
  await vi.waitFor(() => expect(screen.getByText("Filed ATL-571 and assigned it to Sam Lee.")).toBeTruthy());
  return s;
};

const find = async (q: string) => {
  fireEvent.keyDown(box(), { key: "f", metaKey: true });
  const field = screen.getByRole("textbox", { name: "Search your chat with Allan" });
  fireEvent.change(field, { target: { value: q } });
  await screen.findByRole("button", { name: /Started Ledger Migration/ });
  return field;
};
const results = () => screen.getByRole("complementary", { name: "Matches" });

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.reset();
  kept.state.clear();
  asked = [];
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
    around: {},
  });
  useReads.setState({ local: {}, dms: {}, loaded: true });
});
afterEach(cleanup);

describe("searching a DM", () => {
  it("lists the hub's matches from the whole history, newest first", async () => {
    await open();
    await find("ledger");
    const search = asked.find((a) => a.path.endsWith("/search"))!;
    expect(search.path).toBe("/api/desk/conversations/allan/search");
    expect(search.query.get("q")).toBe("ledger");
    const items = within(results()).getAllByRole("button").filter((b) => b.classList.contains("dm-result"));
    expect(items.map((b) => b.textContent)).toEqual([expect.stringContaining("Filed ATL-571"), expect.stringContaining("Started Ledger Migration")]);
    expect(within(results()).getAllByText("Ledger", { selector: "mark" }).length).toBeGreaterThan(0);
  });

  it("shows a loaded match in place, and reads the chat around one that isn't", async () => {
    await open();
    const field = await find("ledger");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(asked.some((a) => a.query.get("around"))).toBe(false);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByText("2 of 2")).toBeTruthy();
    await screen.findByText("start a session to move atlas onto ledger");
    expect(asked.find((a) => a.query.get("around"))!.query.get("around")).toBe("o2");
    expect(screen.queryByText("Filed ATL-571 and assigned it to Sam Lee.", { selector: ".msg-body *" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /Jump to latest/ })[0]!);
    expect(screen.queryByText("start a session to move atlas onto ledger")).toBeNull();
    expect(screen.getAllByText("Filed ATL-571 and assigned it to Sam Lee.").length).toBeGreaterThan(0);
  });

  it("closes with Esc, and isn't offered by a hub that can't", async () => {
    await open();
    const field = await find("ledger");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
    cleanup();
    for (const key of Object.keys(useChat.getState().conversations)) useChat.getState().forget(key);
    FakeSocket.reset();
    await open(FEATURES.filter((f) => f !== "desk.search"));
    fireEvent.keyDown(box(), { key: "f", metaKey: true });
    expect(screen.queryByRole("search")).toBeNull();
  });
});

describe("searching with the queue", () => {
  it("leaves the queue alone: it still goes when the turn ends, and shows once you're back at the latest", async () => {
    const s = await open();
    act(() => type("check the deploy"));
    const ref = s.chats[0]!.turn_ref as string;
    act(() => s.receive({ type: "typing", session_id: "s-allan", turn_ref: ref }));
    act(() => type("and staging"));
    const field = await find("ledger");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    await screen.findByText("start a session to move atlas onto ledger");
    expect(queued()).toEqual(["and staging"]);
    await act(async () => {
      s.receive({ type: "turn_end", session_id: "s-allan", turn_ref: ref });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(s.chats[1]).toMatchObject({ content: "and staging", mode: "queue" });
    fireEvent.click(screen.getAllByRole("button", { name: /Jump to latest/ })[0]!);
    expect(screen.getAllByText("and staging", { selector: ".msg-text *, .msg-text" }).length).toBeGreaterThan(0);
  });
});
