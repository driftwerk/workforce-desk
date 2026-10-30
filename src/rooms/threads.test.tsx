import { act, cleanup, render, screen } from "@testing-library/react";
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
const { arrived, merge, threadRead, useDesk } = await import("../hub/store");
const { ROOM_PAGE } = await import("../hub/client");
const { useUi } = await import("../shell/ui");
const { RoomView, ThreadPanel } = await import("./RoomView");

const room = {
  id: "r1",
  slug: "release",
  name: "release",
  channel: "desk:r1",
  members: [{ hub: "local", agent: "scout" }],
  defaultMember: "local/scout",
  createdAt: "",
  updatedAt: "",
};

Element.prototype.scrollIntoView = () => {};

const message = (id: string, over: Partial<RoomMessage> = {}): RoomMessage => ({
  id,
  roomId: "r1",
  threadId: null,
  author: "you",
  content: id,
  hop: 0,
  createdAt: `2026-10-30T10:0${id.length}:00Z`,
  ...over,
});

const reply = (id: string, thread: string, createdAt: string, author = "local/scout") =>
  message(id, { threadId: thread, author, createdAt });

const draft = (threadId: string): RoomDraft => ({
  id: "ask-1",
  member: "local/scout",
  threadId,
  text: "",
  working: null,
  tools: [],
  attachments: [],
  prompts: [],
  state: "live",
});

beforeEach(() => {
  useChat.setState({
    hubs: [{ id: "local", label: "This Mac", url: "http://127.0.0.1:1", local: true, token: "t" }],
    roster: [{ hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false }],
  });
  useUi.setState({ roomThreads: {} });
  useDesk.setState({
    rooms: { r1: room },
    timelines: {
      r1: [
        message("a", { replyCount: 2, lastReplyAt: "2026-10-30T11:00:00Z" }),
        message("bb", { replyCount: 0, lastReplyAt: null }),
      ],
    },
    roomDrafts: {},
  });
});
afterEach(cleanup);

const links = () => screen.getAllByRole("button", { name: /repl/i }).map((b) => b.textContent);

describe("a room's thread links", () => {
  it("say how many replies a thread has from the hub's count, without the thread opened", () => {
    render(<RoomView room={room} />);
    expect(links()).toEqual(["2 replies", "Reply in thread"]);
  });

  it("count a reply that arrives while the thread is closed", () => {
    render(<RoomView room={room} />);
    act(() => useDesk.getState().keep(reply("r9", "bb", "2026-10-30T12:00:00Z")));
    expect(links()).toEqual(["2 replies", "1 reply"]);
    expect(useDesk.getState().timelines.r1!.find((m) => m.id === "bb")?.lastReplyAt).toBe("2026-10-30T12:00:00Z");
  });

  it("count your own reply once, though its post and its event both arrive", () => {
    render(<RoomView room={room} />);
    const mine = reply("r7", "a", "2026-10-30T12:00:00Z", "you");
    act(() => useDesk.getState().keep(mine));
    act(() => useDesk.getState().keep({ ...mine }));
    expect(links()).toEqual(["3 replies", "Reply in thread"]);
  });

  it("say who's replying in a closed thread, and show the draft only in its own thread", () => {
    useDesk.setState({ roomDrafts: { r1: [draft("bb")] } });
    render(<RoomView room={room} />);
    expect(screen.getByText("Scout is replying…")).toBeTruthy();
    expect(screen.queryByLabelText("Scout’s answer on its way")).toBeNull();
    cleanup();
    useUi.setState({ roomThreads: { r1: "bb" } });
    render(<RoomView room={room} />);
    expect(screen.queryByText("Scout is replying…")).toBeNull();
    expect(screen.queryByLabelText("Scout’s answer on its way")).toBeNull();
    cleanup();
    render(<ThreadPanel room={room} thread="bb" />);
    expect(screen.getByLabelText("Scout’s answer on its way")).toBeTruthy();
  });

  it("say who couldn't answer in a closed thread, and not that they're replying while they wait or after", () => {
    useDesk.setState({ roomDrafts: { r1: [{ ...draft("bb"), state: "failed", error: "The model gave up." }, { ...draft("a"), id: "ask-2", state: "queued" }] } });
    render(<RoomView room={room} />);
    expect(screen.queryByText(/replying…/)).toBeNull();
    expect(screen.getByText("Scout couldn’t answer")).toBeTruthy();
  });
});

describe("a timeline's reply counts", () => {
  it("leave the hub's count alone as a timeline is read, and count from loaded replies when a whole thread is read", () => {
    const replies = [reply("x", "a", "2026-10-30T10:30:00Z"), reply("y", "a", "2026-10-30T10:40:00Z")];
    expect(merge([message("a", { replyCount: 2 })], replies).find((m) => m.id === "a")?.replyCount).toBe(2);
    const read = threadRead(merge([message("a", { replyCount: 5 })], replies), "a", true);
    expect(read.find((m) => m.id === "a")).toMatchObject({ replyCount: 2, lastReplyAt: "2026-10-30T10:40:00Z" });
  });

  it("keep the hub's count of a thread longer than the page read of it", () => {
    const parent = message("a", { replyCount: 250, lastReplyAt: "2026-10-30T12:00:00Z" });
    const page = Array.from({ length: ROOM_PAGE }, (_, i) => reply(`p${i}`, "a", `2026-10-30T11:${String(i % 60).padStart(2, "0")}:00Z`));
    const read = threadRead(merge([parent], page), "a", false);
    expect(read.find((m) => m.id === "a")).toMatchObject({ replyCount: 250, lastReplyAt: "2026-10-30T12:00:00Z" });
  });

  it("leave a parent from a hub that counts none to the replies loaded", () => {
    const heard = arrived([message("a")], reply("x", "a", "2026-10-30T10:30:00Z"));
    expect(heard.find((m) => m.id === "a")?.replyCount).toBeUndefined();
  });
});
