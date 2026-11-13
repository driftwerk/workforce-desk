import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../testing/sockets";

// ↑ edits your last message. With something still in the queue, it edits
// the last queued message in place: it hasn't been sent, so nothing is
// asked again. Otherwise it edits your latest sent message, once the agent
// has finished and nothing waits behind it: saving sets aside the old
// message and the reply to it, and the agent answers the new version,
// told what that reply had already done.

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
const FEATURES = ["desk.place", "desk.stream", "desk.queue", "desk.client_ids", "desk.edit"];
const at = (min: number) => new Date(Date.parse("2026-11-10T09:00:00Z") + min * 60_000).toISOString();

/** You asked to file a bug; Allan's reply filed and assigned it. */
const history = [
  { id: "k0", from: "assistant", text: "Want me to file the leads bug?", at: at(0) },
  { id: "k1", from: "user", text: "yes file it and assign to Sam", at: at(1), client_id: "c1" },
  {
    id: "k2",
    from: "assistant",
    text: "Filed ATL-571 and assigned it to Sam Lee.",
    at: at(2),
    mark: { steps: [{ tool: "linear.create_issue", ok: true, ms: 300 }, { tool: "linear.assign", ok: true, ms: 120 }] },
  },
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
const up = () => fireEvent.keyDown(box(), { key: "ArrowUp" });
const queued = () => [...document.querySelectorAll(".queued-text")].map((e) => e.textContent);

/** What the hub's read returns; a test may change it. */
let read: object[] = history;

const open = async (features = FEATURES) => {
  read = history;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ messages: read, more: false }), { headers: { "content-type": "application/json" } })),
  );
  render(<Rooms />);
  act(() => useChat.getState().openDm(KEY));
  const s = await connect(features);
  await vi.waitFor(() => expect(screen.getByText("Filed ATL-571 and assigned it to Sam Lee.")).toBeTruthy());
  return s;
};

/** A turn the hub is working on, from a message you send now. */
const busy = (s: FakeSocket, text = "check the deploy") => {
  act(() => type(text));
  const ref = s.chats.at(-1)!.turn_ref as string;
  act(() => s.receive({ type: "typing", session_id: "s-allan", turn_ref: ref }));
  return ref;
};

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
    setAside: {},
  });
  useReads.setState({ local: {}, dms: {}, loaded: true });
});
afterEach(cleanup);

describe("↑ with queued messages", () => {
  it("edits the last queued message in place, and nothing is asked again", async () => {
    const s = await open();
    busy(s);
    act(() => type("and staging"));
    act(() => type("then tell me"));
    act(() => up());
    const edit = screen.getByRole("textbox", { name: "Edit queued message" }) as HTMLTextAreaElement;
    expect(edit.value).toBe("then tell me");
    fireEvent.change(edit, { target: { value: "then tell me both" } });
    fireEvent.keyDown(edit, { key: "Enter" });
    expect(queued()).toEqual(["and staging", "then tell me both"]);
    expect(s.chats).toHaveLength(1);
    expect(s.chats.some((c) => (c.desk as { edit?: unknown } | undefined)?.edit)).toBe(false);
    expect(screen.queryByRole("form", { name: "Editing your last message" })).toBeNull();
  });

  it("skips a queued message already on its way", async () => {
    const s = await open();
    const ref = busy(s);
    act(() => type("and staging"));
    // The turn ends: the queue goes, and is on its way until the hub takes it.
    await act(async () => {
      s.receive({ type: "turn_end", session_id: "s-allan", turn_ref: ref });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getAllByText("Sending…").length).toBeGreaterThan(0);
    act(() => up());
    expect(screen.queryByRole("textbox", { name: "Edit queued message" })).toBeNull();
  });

  it("doesn't let your last sent message be edited while queued messages wait behind it", async () => {
    const s = await open();
    const ref = busy(s);
    act(() => type("and staging"));
    // Stopped: the turn ends, and what's queued waits, paused, behind your
    // latest sent message.
    act(() => useChat.getState().cancel(KEY));
    await act(async () => {
      s.receive({ type: "turn_end", session_id: "s-allan", turn_ref: ref });
      await new Promise((r) => setTimeout(r, 0));
    });
    const mine = screen.getByText("check the deploy").closest(".room-msg")!;
    fireEvent.click(within(mine as HTMLElement).getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("form", { name: "Editing your last message" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("You can edit your last message once your queued messages have gone.");
    expect(queued()).toEqual(["and staging"]);
  });
});

describe("↑ with nothing queued", () => {
  it("opens your last message, lists what the reply did, and asks again with the new version", async () => {
    const s = await open();
    act(() => up());
    const form = screen.getByRole("form", { name: "Editing your last message" });
    const text = within(form).getByRole("textbox", { name: "Your last message" }) as HTMLTextAreaElement;
    expect(text.value).toBe("yes file it and assign to Sam");
    expect(form.textContent).toContain("Allan’s reply to it already did 2 things:");
    expect(form.textContent).toContain("linear.create_issue");
    // The reply being set aside is dimmed while you edit.
    expect(screen.getByText("Filed ATL-571 and assigned it to Sam Lee.").closest(".room-msg")!.classList.contains("msg-dim")).toBe(true);
    fireEvent.change(text, { target: { value: "yes file it and assign to me" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save and ask again" }));
    expect(s.chats.at(-1)).toMatchObject({ content: "yes file it and assign to me", desk: { place: { kind: "dm" }, edit: { replaces: "k1" } } });
    // The old message and the reply to it are set aside; the new one reads (edited).
    expect(screen.queryByText("yes file it and assign to Sam")).toBeNull();
    expect(screen.queryByText("Filed ATL-571 and assigned it to Sam Lee.")).toBeNull();
    const fresh = screen.getByText("yes file it and assign to me").closest("article")!;
    expect(fresh.textContent).toContain("(edited)");
    expect(box()).toBeTruthy();
  });

  it("brings back what was set aside when the hub refuses the edit", async () => {
    const s = await open();
    act(() => up());
    const text = screen.getByRole("textbox", { name: "Your last message" });
    fireEvent.change(text, { target: { value: "yes file it and assign to me" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and ask again" }));
    expect(screen.queryByText("Filed ATL-571 and assigned it to Sam Lee.")).toBeNull();
    const ref = s.chats.at(-1)!.turn_ref as string;
    await act(async () => {
      s.receive({ type: "error", session_id: "s-allan", turn_ref: ref, error: "only your latest message can be edited" });
      s.receive({ type: "turn_end", session_id: "s-allan", turn_ref: ref });
      await new Promise((r) => setTimeout(r, 0));
    });
    await vi.waitFor(() => expect(screen.getByText("Filed ATL-571 and assigned it to Sam Lee.")).toBeTruthy());
    expect(screen.getByText("yes file it and assign to Sam")).toBeTruthy();
    expect(useChat.getState().setAside[KEY]).toEqual([]);
    // The version that didn't take goes, and its words come back to you.
    expect(document.querySelector(".msg-edited")).toBeNull();
    expect(box().value).toBe("yes file it and assign to me");
    expect(screen.getByRole("status").textContent).toBe(
      "Allan’s hub didn’t take your edit (only your latest message can be edited). Your words are back in the box.",
    );
  });

  it("brings back what was set aside when the connection drops before the hub has the edit", async () => {
    const s = await open();
    act(() => up());
    fireEvent.change(screen.getByRole("textbox", { name: "Your last message" }), { target: { value: "yes file it and assign to me" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and ask again" }));
    expect(screen.queryByText("yes file it and assign to Sam")).toBeNull();
    await act(async () => {
      s.drop();
      await new Promise((r) => setTimeout(r, 0));
    });
    await vi.waitFor(() => expect(screen.getByText("yes file it and assign to Sam")).toBeTruthy());
    expect(screen.getByText("Filed ATL-571 and assigned it to Sam Lee.")).toBeTruthy();
    expect(box().value).toBe("yes file it and assign to me");
  });

  it("keeps the old pair gone once the hub's read leaves them out, live copies included", async () => {
    const s = await open();
    // Asked and answered live: shown from the live copies until the hub's
    // kept ones take their place.
    act(() => type("and close the old one"));
    const asked = s.chats.at(-1)!;
    const ref = asked.turn_ref as string;
    const cid = (asked.desk as { message: string }).message;
    await act(async () => {
      s.receive({ type: "stream_start", session_id: "s-allan", turn_ref: ref, id: "r9" });
      s.receive({ type: "stream_delta", session_id: "s-allan", turn_ref: ref, id: "r9", content: "Closed ATL-560." });
      s.receive({ type: "stream_end", session_id: "s-allan", turn_ref: ref, id: "r9" });
      read = [
        ...history,
        { id: "k3", from: "user", text: "and close the old one", at: at(3), client_id: cid },
        { id: "k4", from: "assistant", text: "Closed ATL-560.", at: at(4), mark: { in_reply_to: cid } },
      ];
      s.receive({ type: "turn_end", session_id: "s-allan", turn_ref: ref, id: "k4" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      await useChat.getState().refreshHistory(KEY);
    });
    act(() => up());
    fireEvent.change(screen.getByRole("textbox", { name: "Your last message" }), { target: { value: "and close both old ones" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and ask again" }));
    const edit = s.chats.at(-1)!;
    expect(edit).toMatchObject({ desk: { edit: { replaces: "k3" } } });
    const eid = (edit.desk as { message: string }).message;
    // The hub took it: its read no longer has the old pair.
    read = [...history, { id: "k5", from: "user", text: "and close both old ones", at: at(5), client_id: eid, mark: { edited: true } }];
    await act(async () => {
      s.receive({ type: "turn_end", session_id: "s-allan", turn_ref: edit.turn_ref as string });
      await useChat.getState().refreshHistory(KEY);
    });
    expect(screen.queryByText("and close the old one")).toBeNull();
    expect(screen.queryByText("Closed ATL-560.")).toBeNull();
    expect(screen.getByText("and close both old ones")).toBeTruthy();
  });

  it("cancels with Esc, and an unchanged save asks nothing", async () => {
    const s = await open();
    act(() => up());
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Your last message" }), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Editing your last message" })).toBeNull();
    act(() => up());
    fireEvent.click(screen.getByRole("button", { name: "Save and ask again" }));
    expect(s.chats).toHaveLength(0);
    expect(screen.getByText("yes file it and assign to Sam")).toBeTruthy();
  });

  it("says why not while the agent is still replying", async () => {
    const s = await open();
    act(() => s.receive({ type: "typing", session_id: "s-allan" }));
    act(() => up());
    expect(screen.queryByRole("form", { name: "Editing your last message" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("You can edit your last message once Allan has finished replying.");
  });

  it("offers nothing on a hub that can't replace a message", async () => {
    await open(FEATURES.filter((f) => f !== "desk.edit"));
    act(() => up());
    expect(screen.queryByRole("form", { name: "Editing your last message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});
