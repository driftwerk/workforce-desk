import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../testing/sockets";

// Where a DM stays while you read it. It follows the newest message only
// when you're already there; scrolled up, what you're reading stays put
// whatever changes height above or below it (an earlier page, a table or
// image finishing drawing, a reply streaming, the queue under the
// composer). Jump to latest takes you back, with a count of what arrived.

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
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emitTo: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));

/** What the ResizeObservers watch; `resized()` is a late draw. */
const observers = vi.hoisted(() => new Set<() => void>());
vi.stubGlobal(
  "ResizeObserver",
  class {
    private f: () => void;
    constructor(f: () => void) {
      this.f = () => f();
    }
    observe() {
      observers.add(this.f);
    }
    disconnect() {
      observers.delete(this.f);
    }
    unobserve() {}
  },
);
const resized = () => act(() => [...observers].forEach((f) => f()));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useUi } = await import("../shell/ui");
const { useReads } = await import("../unread/reads");
const { Rooms } = await import("./Rooms");

Element.prototype.scrollIntoView = () => {};

const KEY = "dw/allan";
const FEATURES = ["desk.place", "desk.stream", "desk.queue", "desk.client_ids"];
const T0 = Date.parse("2026-11-10T09:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

/** Kept messages as the hub sends them: you and Allan in turn, a minute apart. */
const kept20 = (n = 20) =>
  Array.from({ length: n }, (_, i) => ({
    id: `k${i}`,
    from: i % 2 ? "assistant" : "user",
    text: `said ${i}`,
    at: at(i),
  }));

// jsdom lays nothing out: each message is ROW tall (or as said), stacked,
// in a pane VIEW tall whose scrollTop is clamped as a browser's is.
const ROW = 100;
let VIEW = 300;
const tall = new Map<string, number>();
const rows = (pane: HTMLElement) => [
  ...pane.querySelectorAll<HTMLElement>("[data-message-id]"),
];
const tops = (pane: HTMLElement) => {
  const by = new Map<HTMLElement, number>();
  let y = 0;
  for (const r of rows(pane)) {
    by.set(r, y);
    y += tall.get(r.dataset.messageId!) ?? ROW;
  }
  return { by, total: y };
};
let pane: HTMLElement;
let top = 0;
const laidOut = () => {
  pane = document.querySelector<HTMLElement>(".room-scroll")!;
  top = 0;
  Object.defineProperty(pane, "scrollHeight", {
    configurable: true,
    get: () => Math.max(tops(pane).total, VIEW),
  });
  Object.defineProperty(pane, "clientHeight", {
    configurable: true,
    get: () => VIEW,
  });
  Object.defineProperty(pane, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) =>
      (top = Math.max(0, Math.min(v, pane.scrollHeight - VIEW))),
  });
  pane.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: VIEW,
      left: 0,
      right: 600,
      height: VIEW,
      width: 600,
    }) as DOMRect;
};
const realRect = HTMLElement.prototype.getBoundingClientRect;
HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  if (pane && this.dataset.messageId && pane.contains(this)) {
    const y = (tops(pane).by.get(this) ?? 0) - pane.scrollTop;
    const h = tall.get(this.dataset.messageId) ?? ROW;
    return {
      top: y,
      bottom: y + h,
      left: 0,
      right: 600,
      height: h,
      width: 600,
    } as DOMRect;
  }
  return realRect.call(this);
};
const atEnd = () => pane.scrollTop >= pane.scrollHeight - VIEW - 1;
/** Where message `id` sits from the pane's top. */
const offsetOf = (id: string) =>
  pane
    .querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
    .getBoundingClientRect().top;
/** You scroll the pane to `y`. */
const scrollTo = (y: number) =>
  act(() => {
    pane.scrollTop = y;
    fireEvent.scroll(pane);
  });

const connect = async () => {
  await vi.waitFor(() => expect(FakeSocket.find("/ws", "allan")).toBeDefined());
  const s = FakeSocket.find("/ws", "allan")!;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    s.receive({ type: "connected", session_id: "s-allan", features: FEATURES });
  });
  return s;
};

const box = () =>
  screen.getByPlaceholderText("Message Allan") as HTMLTextAreaElement;
const type = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: "Enter" });
};

/** Opens the DM over `history`, laid out, at its end. */
const open = async (history = kept20()) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: history, more: false }), {
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  render(<Rooms />);
  act(() => useChat.getState().openDm(KEY));
  laidOut();
  const s = await connect();
  await vi.waitFor(() => expect(rows(pane)).toHaveLength(history.length));
  resized();
  return s;
};

/** Allan answers turn `ref` word by word. */
const streams = (s: FakeSocket, ref: string, id: string, words: string[]) =>
  act(() => {
    s.receive({ type: "typing", session_id: "s-allan", turn_ref: ref });
    s.receive({
      type: "stream_start",
      session_id: "s-allan",
      turn_ref: ref,
      id,
    });
    for (const w of words)
      s.receive({
        type: "stream_delta",
        session_id: "s-allan",
        turn_ref: ref,
        id,
        content: `${w} `,
      });
  });
const ends = (s: FakeSocket, ref: string, id: string) =>
  act(async () => {
    s.receive({ type: "stream_end", session_id: "s-allan", turn_ref: ref, id });
    s.receive({ type: "turn_end", session_id: "s-allan", turn_ref: ref, id });
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.reset();
  kept.state.clear();
  tall.clear();
  VIEW = 300;
  useDesk.setState({
    view: "rooms",
    activeRoom: null,
    inbox: false,
    hub: null,
  });
  for (const key of Object.keys(useChat.getState().conversations))
    useChat.getState().forget(key);
  useChat.setState({
    hubs: [
      {
        id: "dw",
        label: "Acme",
        url: "https://acme.example.com",
        local: false,
        revision: "t",
      },
    ],
    roster: [
      {
        hubId: "dw",
        id: "allan",
        name: "Allan",
        model: null,
        provider: null,
        isDefault: false,
      },
    ],
    rosterRead: true,
    queues: {},
    histories: {},
  });
  useUi.setState({ anchors: {} });
  useReads.setState({ local: {}, dms: {}, loaded: true });
});
afterEach(() => {
  cleanup();
  observers.clear();
});

describe("a DM at its newest message", () => {
  it("stays there when a message above it finishes drawing taller (the scroll-up bug)", async () => {
    await open();
    expect(atEnd()).toBe(true);
    // A table in an earlier answer lays itself out: the content grows above
    // the reader, with nothing sent or streamed.
    tall.set("k17", 400);
    resized();
    expect(atEnd()).toBe(true);
  });

  it("follows a reply as it streams", async () => {
    const s = await open();
    act(() => type("and now?"));
    await streams(s, s.chats[0]!.turn_ref as string, "a1", ["one", "two"]);
    tall.set("a1", 500);
    resized();
    expect(atEnd()).toBe(true);
  });

  it("stays at the end as the queue under the composer grows and goes", async () => {
    const s = await open();
    act(() => type("check the deploy"));
    const ref = s.chats[0]!.turn_ref as string;
    await streams(s, ref, "a1", ["working"]);
    act(() => type("and staging"));
    // The queue takes room from the pane.
    VIEW = 220;
    resized();
    expect(atEnd()).toBe(true);
    await ends(s, ref, "a1");
    VIEW = 300;
    resized();
    expect(atEnd()).toBe(true);
  });
});

describe("a DM scrolled up", () => {
  it("keeps what you're reading in place when a message above it finishes drawing", async () => {
    await open();
    scrollTo(1000);
    const was = offsetOf("k11");
    tall.set("k4", 380);
    resized();
    expect(offsetOf("k11")).toBe(was);
  });

  it("isn't pulled down as a reply streams in below", async () => {
    const s = await open();
    act(() => type("and now?"));
    scrollTo(900);
    const was = offsetOf("k10");
    await streams(s, s.chats[0]!.turn_ref as string, "a1", [
      "one",
      "two",
      "three",
    ]);
    tall.set("a1", 600);
    resized();
    expect(offsetOf("k10")).toBe(was);
    expect(atEnd()).toBe(false);
  });

  it("keeps its place as an earlier page lands while a reply streams below", async () => {
    const newest = kept20().slice(10);
    let landed: (page: unknown) => void = () => {};
    const s = await open(newest.map((m) => ({ ...m })));
    // The hub has more before: the next read is the earlier page.
    act(() =>
      useChat.setState((st) => ({
        histories: {
          ...st.histories,
          [KEY]: { ...st.histories[KEY]!, more: true },
        },
      })),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((r) => (landed = r))),
    );
    act(() => type("and now?"));
    scrollTo(50);
    const was = offsetOf("k11");
    await streams(s, s.chats[0]!.turn_ref as string, "a1", ["one", "two"]);
    await act(async () => {
      landed(
        new Response(
          JSON.stringify({ messages: kept20().slice(0, 10), more: false }),
          { headers: { "content-type": "application/json" } },
        ),
      );
      await new Promise((r) => setTimeout(r, 0));
    });
    await vi.waitFor(() => expect(rows(pane).length).toBeGreaterThan(12));
    resized();
    expect(offsetOf("k11")).toBe(was);
  });

  it("stays put as the queue grows and drains, and the drained message isn't counted new", async () => {
    const s = await open();
    act(() => type("check the deploy"));
    const ref = s.chats[0]!.turn_ref as string;
    scrollTo(800);
    const was = offsetOf("k9");
    await streams(s, ref, "a1", ["working"]);
    // Queued while scrolled up: nothing moves.
    act(() => type("and staging"));
    act(() => type("then tell me"));
    expect(offsetOf("k9")).toBe(was);
    VIEW = 200;
    resized();
    expect(offsetOf("k9")).toBe(was);
    // The turn ends: the queue goes as one message of yours.
    await ends(s, ref, "a1");
    expect(s.chats[1]).toMatchObject({
      content: "and staging\n\nthen tell me",
      mode: "queue",
    });
    VIEW = 300;
    resized();
    expect(offsetOf("k9")).toBe(was);
    expect(
      screen.getByRole("button", { name: /Jump to latest/ }).textContent,
    ).toContain("1 new");
  });

  it("shows Jump to latest with what Allan said since, and End or a click goes there", async () => {
    const s = await open();
    scrollTo(600);
    const pill = () => screen.queryByRole("button", { name: /Jump to latest/ });
    expect(pill()?.textContent).not.toMatch(/new/);
    act(() => type("two things"));
    // What you send yourself takes you to the end.
    expect(atEnd()).toBe(true);
    expect(pill()).toBeNull();
    scrollTo(600);
    const ref = s.chats[0]!.turn_ref as string;
    await streams(s, ref, "a1", ["first"]);
    await ends(s, ref, "a1");
    expect(pill()?.textContent).toContain("1 new");
    fireEvent.click(pill()!);
    expect(atEnd()).toBe(true);
    scrollTo(600);
    fireEvent.keyDown(pane, { key: "End" });
    expect(atEnd()).toBe(true);
  });
});

describe("coming back to a DM", () => {
  it("opens at a New line before what you haven't read", async () => {
    useReads.setState({ dms: { [KEY]: { at: at(15), message: "k15" } } });
    await open();
    const line = screen.getByRole("separator", { name: "New messages" });
    expect(
      line.nextElementSibling
        ?.querySelector("[data-message-id]")
        ?.getAttribute("data-message-id") ??
        line.nextElementSibling?.getAttribute("data-message-id"),
    ).toBe("k17");
    expect(atEnd()).toBe(false);
  });
});
