import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomDraft } from "../hub/store";
import type { RoomMessage } from "../hub/types";

vi.mock("./engine", () => ({
  say: vi.fn(async () => {}),
  answerForm: vi.fn(async () => {}),
  prune: () => {},
  retry: () => {},
  dismiss: () => {},
  answerPrompt: () => true,
}));
vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: unknown }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useUi } = await import("../shell/ui");
const { Timeline } = await import("./Timeline");

const room = {
  id: "r1",
  slug: "atlas-launch",
  name: "Atlas launch",
  channel: "desk:r1",
  members: [{ hub: "local", agent: "allan" }],
  defaultMember: "local/allan",
  createdAt: "",
  updatedAt: "",
};

const DAY = 86_400_000;
const msg = (id: string, at: number, over: Partial<RoomMessage> = {}): RoomMessage => ({
  id,
  roomId: "r1",
  threadId: null,
  author: "local/allan",
  content: `said ${id}`,
  hop: 0,
  createdAt: new Date(at).toISOString(),
  ...over,
});
const draft = (text: string): RoomDraft => ({
  id: "ask-1",
  member: "local/allan",
  threadId: null,
  asked: "q1",
  since: 0,
  text,
  working: null,
  tools: [],
  attachments: [],
  prompts: [],
  state: "live",
});

/** jsdom lays nothing out: the pane says it is `height` tall over content of `content`. */
const sized = (pane: HTMLElement, content: number, height = 200) => {
  Object.defineProperty(pane, "scrollHeight", { configurable: true, value: content });
  Object.defineProperty(pane, "clientHeight", { configurable: true, value: height });
};
const scrollTo = (pane: HTMLElement, top: number) => {
  pane.scrollTop = top;
  fireEvent.scroll(pane);
};

beforeEach(() => {
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, token: "t" }],
    roster: [{ hubId: "local", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
  });
  useUi.setState({ roomThreads: {}, anchors: {}, flash: null });
  useDesk.setState({ rooms: { r1: room }, timelines: {}, windows: {}, paging: {}, roomDrafts: {} });
});
afterEach(cleanup);

describe("a room's timeline", () => {
  it("puts the day before the first message of each day", () => {
    const now = Date.now();
    useDesk.setState({ timelines: { r1: [msg("a", now - DAY - 60_000), msg("b", now - DAY), msg("c", now - 1000)] } });
    render(<Timeline room={room} thread={null} />);
    expect(screen.getAllByRole("separator").map((s) => s.textContent)).toEqual(["Yesterday", "Today"]);
  });

  it("follows what streams in at the end, and never moves someone scrolled up", () => {
    useDesk.setState({ timelines: { r1: [msg("a", Date.now() - 1000)] }, roomDrafts: { r1: [draft("Two")] } });
    const { container } = render(<Timeline room={room} thread={null} />);
    const pane = container.querySelector<HTMLElement>(".room-scroll")!;
    sized(pane, 1000);
    scrollTo(pane, 800);
    sized(pane, 1100);
    act(() => useDesk.setState({ roomDrafts: { r1: [draft("Two PRs")] } }));
    expect(pane.scrollTop).toBe(1100);
    scrollTo(pane, 300);
    sized(pane, 1300);
    act(() => useDesk.setState({ roomDrafts: { r1: [draft("Two PRs are left")] } }));
    expect(pane.scrollTop).toBe(300);
  });

  it("reads the earlier page near the top and keeps the reader where they were", async () => {
    const now = Date.now();
    const older = [msg("a", now - 5000), msg("b", now - 4000)];
    const newest = [msg("c", now - 3000), msg("d", now - 2000)];
    let landed: () => void = () => {};
    const roomMessages = vi.fn(
      () =>
        new Promise<RoomMessage[]>((r) => {
          landed = () => r(older);
        }),
    );
    useDesk.setState({
      hub: { roomMessages } as never,
      timelines: { r1: newest },
      windows: { r1: { older: { kind: "at", id: "c", at: newest[0]!.createdAt }, newer: { kind: "end" } } },
    });
    const { container } = render(<Timeline room={room} thread={null} />);
    const pane = container.querySelector<HTMLElement>(".room-scroll")!;
    sized(pane, 1000);
    scrollTo(pane, 40);
    await vi.waitFor(() => expect(roomMessages).toHaveBeenCalledWith("r1", { before: "c", limit: 100 }));
    expect(screen.getByRole("button", { name: "Loading earlier messages…" })).toBeTruthy();
    sized(pane, 1600);
    await act(async () => landed());
    expect(pane.scrollTop).toBe(640);
    expect(screen.queryByRole("button", { name: /earlier messages/ })).toBeNull();
  });

  it("keeps the reader where they were when something arrives while the earlier page loads", async () => {
    const now = Date.now();
    const older = [msg("a", now - 5000), msg("b", now - 4000)];
    const newest = [msg("c", now - 3000), msg("d", now - 2000)];
    let landed: () => void = () => {};
    const roomMessages = vi.fn(() => new Promise<RoomMessage[]>((r) => (landed = () => r(older))));
    useDesk.setState({
      hub: { roomMessages } as never,
      timelines: { r1: newest },
      windows: { r1: { older: { kind: "at", id: "c", at: newest[0]!.createdAt }, newer: { kind: "end" } } },
    });
    const { container } = render(<Timeline room={room} thread={null} />);
    const pane = container.querySelector<HTMLElement>(".room-scroll")!;
    sized(pane, 1000);
    scrollTo(pane, 40);
    await vi.waitFor(() => expect(roomMessages).toHaveBeenCalled());
    act(() => useDesk.setState({ timelines: { r1: [...newest, msg("t1", now - 1000, { threadId: "c" })] } }));
    expect(pane.scrollTop).toBe(40);
    sized(pane, 1600);
    await act(async () => landed());
    expect(pane.scrollTop).toBe(640);
  });

  it("says it shows older messages, and goes to the newest", () => {
    const now = Date.now();
    const toNewest = vi.fn(async () => {});
    useDesk.setState({
      toNewest,
      timelines: { r1: [msg("a", now - 5000), msg("b", now - 4000), msg("c", now - 1000)] },
      windows: { r1: { older: { kind: "start" }, newer: { kind: "at", id: "b", at: new Date(now - 4000).toISOString() } } },
      roomDrafts: { r1: [draft("hidden while away")] },
    });
    render(<Timeline room={room} thread={null} />);
    expect(screen.queryByText("said c")).toBeNull();
    expect(screen.queryByText("hidden while away")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Jump to the newest" }));
    expect(toNewest).toHaveBeenCalledWith("r1", null);
  });

  it("goes to the end once the newest is shown again, and with what you send", () => {
    const now = Date.now();
    const b = new Date(now - 4000).toISOString();
    const toNewest = vi.fn(async () => {
      useDesk.setState({ windows: { r1: { older: { kind: "start" }, newer: { kind: "end" } } } });
    });
    useDesk.setState({
      toNewest,
      timelines: { r1: [msg("a", now - 5000), msg("b", now - 4000), msg("c", now - 3000)] },
      windows: { r1: { older: { kind: "start" }, newer: { kind: "at", id: "b", at: b } } },
    });
    const { container } = render(<Timeline room={room} thread={null} />);
    const pane = container.querySelector<HTMLElement>(".room-scroll")!;
    sized(pane, 1000);
    scrollTo(pane, 100);
    fireEvent.click(screen.getByRole("button", { name: "Jump to the newest" }));
    return vi.waitFor(() => expect(pane.scrollTop).toBe(1000)).then(() => {
      scrollTo(pane, 100);
      sized(pane, 1200);
      act(() => useDesk.setState((s) => ({ timelines: { r1: [...s.timelines.r1!, msg("mine", now, { author: "you" })] } })));
      expect(pane.scrollTop).toBe(1200);
    });
  });

  it("flashes a message jumped to once, not again when the room is shown later", () => {
    const now = Date.now();
    useDesk.setState({ timelines: { r1: [msg("a", now - 2000), msg("b", now - 1000)] } });
    useUi.setState({ flash: { id: "a", at: Date.now() } });
    const first = render(<Timeline room={room} thread={null} />);
    expect(first.container.querySelector("[data-row='a']")!.classList.contains("msg-flash")).toBe(true);
    first.unmount();
    useUi.setState({ flash: { id: "a", at: Date.now() - 5000 } });
    const again = render(<Timeline room={room} thread={null} />);
    expect(again.container.querySelector("[data-row='a']")!.classList.contains("msg-flash")).toBe(false);
  });

  it("moves between messages with the arrows and opens a thread with T", () => {
    const now = Date.now();
    useDesk.setState({ timelines: { r1: [msg("a", now - 2000), msg("b", now - 1000)] } });
    const { container } = render(<Timeline room={room} thread={null} />);
    const rows = [...container.querySelectorAll<HTMLElement>("[data-row]")];
    expect(rows.map((r) => r.tabIndex)).toEqual([-1, 0]);
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: "t" });
    expect(useUi.getState().roomThreads).toEqual({ r1: "b" });
  });
});
