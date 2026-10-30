import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: unknown }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));

const said: string[] = [];
const retried: string[] = [];
const stopped: string[] = [];
vi.mock("./engine", () => ({
  say: vi.fn(async (_room: unknown, text: string) => void said.push(text)),
  prune: () => {},
  retry: (_room: string, id: string) => void retried.push(id),
  stop: (_room: string, id: string) => void stopped.push(`stop ${id}`),
  cancelAsk: (_room: string, id: string) => void stopped.push(`cancel ${id}`),
  stopAll: () => void stopped.push("all"),
  dismiss: () => {},
  answerPrompt: () => true,
  answerForm: vi.fn(async () => {}),
}));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { RoomView } = await import("./RoomView");
const { Rooms } = await import("./Rooms");

const room = {
  id: "r1",
  slug: "release",
  name: "release",
  members: [{ hub: "local", agent: "scout" }],
  defaultMember: "local/scout",
  createdAt: "",
  updatedAt: "",
};

// jsdom doesn't lay anything out.
Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
  said.length = 0;
  useChat.setState({
    hubs: [
      { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, token: "t" },
      { id: "dw", label: "Driftwerk", url: "https://dw", local: false, token: "t" },
    ],
    roster: [
      { hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false },
      { hubId: "dw", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false },
    ],
  });
  useDesk.setState({ rooms: { r1: room }, timelines: { r1: [] }, roomDrafts: {} });
});
afterEach(cleanup);

const type = (box: HTMLTextAreaElement, value: string) =>
  fireEvent.change(box, { target: { value, selectionStart: value.length, selectionEnd: value.length } });

describe("the room composer's @ list", () => {
  it("offers the crew as you type @, members first, and says who'd be brought in", () => {
    render(<RoomView room={room} />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    type(box, "hey @");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Scout"),
      expect.stringMatching(/Atlas.*Driftwerk · not in the room yet/),
    ]);
    type(box, "hey @at");
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("puts the one you pick into the message, then Enter sends", async () => {
    render(<RoomView room={room} />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    type(box, "@at");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("@atlas ");
    expect(said).toEqual([]);
    expect(screen.queryByRole("listbox")).toBeNull();
    type(box, "@atlas can you look?");
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(said).toEqual(["@atlas can you look?"]);
  });

  it("moves with the arrows and closes on Escape", () => {
    render(<RoomView room={room} />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    type(box, "@");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe("@atlas ");
    type(box, "@atlas @");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("says plainly what @ does", () => {
    render(<RoomView room={room} />);
    expect(screen.getByPlaceholderText("Message release — @ someone to ask them, or to bring them in")).toBeTruthy();
  });
});

describe("answers on their way in a room", () => {
  it("shows a draft's words and status, what it asks you first, and offers Retry when it was cut off", () => {
    const working = { since: Date.now(), at: Date.now(), phase: "thinking" as const, step: "Thinking" };
    const prompt = {
      requestId: "q1",
      tool: "slack.send",
      content: 'Posts outside Desk, to slack #ops: "deploy done"',
      options: { allow_once: true, deny_once: true, allow_always: true, deny_always: true },
      turnRef: "t1",
    };
    const draft = { member: "local/scout", threadId: null, asked: "q1", since: Date.now(), tools: [], attachments: [], prompts: [], error: undefined };
    useDesk.setState({
      roomDrafts: {
        r1: [
          { ...draft, id: "a1", text: "Two PRs are", working, state: "live", prompts: [prompt] },
          { ...draft, id: "a2", text: "", working: null, state: "interrupted" },
          { ...draft, id: "a3", text: "done", working: null, state: "live", source: "local/scout/m1" },
        ],
      },
      timelines: { r1: [{ id: "p1", roomId: "r1", threadId: null, author: "local/scout", content: "done", hop: 0, createdAt: "", source: "local/scout/m1" }] },
    });
    render(<RoomView room={room} />);
    expect(screen.getByText("Two PRs are")).toBeTruthy();
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retried).toEqual(["a2"]);
    expect(screen.getAllByText("done")).toHaveLength(1);
    const [live, cut] = screen.getAllByRole("article", { name: "Scout’s answer on its way" });
    expect(live!.getAttribute("aria-busy")).toBe("true");
    expect(live!.getAttribute("aria-live")).toBeNull();
    expect(cut!.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("alert").textContent).toMatch(/^Interrupted/);
  });

  it("offers Stop on a live answer, Cancel on a queued one, Stop all when two are live, and Retry on a stopped one", () => {
    stopped.length = 0;
    const draft = { member: "local/scout", threadId: null, asked: "q1", since: Date.now(), tools: [], attachments: [], prompts: [], text: "", working: null };
    useDesk.setState({
      roomDrafts: {
        r1: [
          { ...draft, id: "a1", state: "live" },
          { ...draft, id: "a2", state: "live" },
          { ...draft, id: "a3", state: "queued" },
          { ...draft, id: "a4", state: "stalled" },
          { ...draft, id: "a5", state: "stopped", took: 1 },
        ],
      },
      timelines: { r1: [] },
    });
    render(<RoomView room={room} />);
    const stops = screen.getAllByRole("button", { name: "Stop" });
    expect(stops).toHaveLength(2);
    fireEvent.click(stops[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop all (2)" }));
    expect(stopped).toEqual(["stop a1", "cancel a3", "all"]);
    expect(screen.getByRole("alert").textContent).toMatch(/^Stopped by you · it had taken in 1 more message/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retried).toContain("a5");
  });
});

describe("pictures in a room", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("show members in the header, each agent's messages and the @ list, and you as Desk shows you", async () => {
    const { servePictures } = await import("../pictures/testing");
    const fetch = servePictures();
    const pic = (version: string) => ({ version, source: "chosen" as const, at: "" });
    useChat.setState((s) => ({
      roster: s.roster.map((a) => ({ ...a, picture: pic(`${a.id}-1`) })),
      me: { local: { id: "u-local", name: "Sam", picture: null }, dw: { id: "u-dw", name: "Sam", picture: pic("d1") } },
    }));
    const at = "2026-10-30T09:00:00Z";
    useDesk.setState({
      timelines: {
        r1: [
          { id: "m1", roomId: "r1", threadId: null, author: "you", content: "Status?", hop: 0, createdAt: at },
          { id: "m2", roomId: "r1", threadId: null, author: "local/scout", content: "Green.", hop: 0, createdAt: at },
        ],
      },
    });
    const { container } = render(<RoomView room={room} />);
    await vi.waitFor(() => expect(container.querySelector(".member-stack .mark img")).toBeTruthy());
    const [mine, theirs] = [...container.querySelectorAll(".msg")];
    await vi.waitFor(() => expect(theirs!.querySelector(".mark img")).toBeTruthy());
    await vi.waitFor(() => expect(mine!.querySelector(".mark-person img")).toBeTruthy());
    // This computer's account has none yet: the first connected workspace's picture.
    expect(fetch.mock.calls.map(([u]) => String(u))).toContain("https://dw/api/me/picture");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
    await vi.waitFor(() => expect(screen.getAllByRole("option").every((o) => o.querySelector(".mark img"))).toBe(true));
  });
});

describe("switching rooms", () => {
  it("leaves the files picked for one room behind", () => {
    useDesk.setState({ rooms: { r1: room, r2: { ...room, id: "r2", slug: "ops", name: "ops" } }, timelines: { r1: [], r2: [] }, activeRoom: "r1", loaded: true });
    const { container } = render(<Rooms />);
    const pick = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(pick, { target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] } });
    expect(screen.getByText("notes.txt")).toBeTruthy();
    act(() => useDesk.setState({ activeRoom: "r2" }));
    expect(screen.queryByText("notes.txt")).toBeNull();
  });
});
