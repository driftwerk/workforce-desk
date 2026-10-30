import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const said: string[] = [];
vi.mock("../rooms/engine", () => ({
  say: vi.fn(async (_room: unknown, text: string) => {
    if (text === "fails") throw new Error("the hub is away");
    said.push(text);
  }),
  prune: () => {},
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
// Desk's file, as the native side keeps it.
const file: Record<string, unknown> = {};
vi.mock("../platform", () => ({
  stateLoad: vi.fn(async () => ({})),
  statePut: vi.fn(async (key: string, value: unknown) => void (file[key] = value)),
  stateRemove: vi.fn(async (key: string) => void delete file[key]),
  stateSynced: vi.fn(async () => undefined),
  stateAdopt: vi.fn(async () => true),
  stateFlush: vi.fn(async () => undefined),
  onNativeState: vi.fn(() => Promise.resolve(() => {})),
  subscribe: vi.fn(() => () => {}),
  openUrl: vi.fn(),
}));

const { deskState } = await import("./boot");
const { draftKey, keepFileDrafts, useDraft, withKeptChanges } = await import("./drafts");
const { anchorOf, applyAnchor } = await import("./scroll");
const { edited, opened, saved, useDrafts } = await import("../crew/files");
const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useUi } = await import("../shell/ui");
const { RoomView, ThreadPanel } = await import("../rooms/RoomView");

const room = {
  id: "r1",
  slug: "release",
  name: "release",
  members: [{ hub: "local", agent: "scout" }],
  defaultMember: "local/scout",
  createdAt: "",
  updatedAt: "",
};
const message = (id: string, threadId: string | null = null) => ({
  id,
  roomId: "r1",
  threadId,
  author: "you",
  content: `message ${id}`,
  createdAt: `2026-10-29T09:00:0${id.slice(1)}Z`,
  hop: 0,
});

Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  said.length = 0;
  for (const k of Object.keys(file)) delete file[k];
  for (const { key } of deskState.list("draft.")) deskState.remove(key);
  useChat.setState({ hubs: [], roster: [] });
  useDesk.setState({ rooms: { r1: room }, timelines: { r1: [] }, roomDrafts: {}, hub: null, connected: false });
  useUi.setState({ roomThreads: {}, anchors: {}, agentFiles: {} });
  useDrafts.setState({ drafts: {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const type = (box: HTMLTextAreaElement, value: string) =>
  fireEvent.change(box, { target: { value, selectionStart: value.length, selectionEnd: value.length } });

describe("message drafts", () => {
  it("each conversation keeps its own, written after the debounce or on a flush", async () => {
    const { result, rerender } = renderHook(({ k }) => useDraft(k), { initialProps: { k: draftKey.dm("local/scout") as string | null } });
    act(() => result.current[1]("half a thou"));
    expect(file["draft.dm.local/scout"]).toBeUndefined();
    act(() => result.current[1]("half a thought"));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(file["draft.dm.local/scout"]).toBe("half a thought");
    rerender({ k: draftKey.dm("dw/atlas") });
    expect(result.current[0]).toBe("");
    act(() => result.current[1]("for atlas"));
    await act(() => deskState.flush());
    expect(file["draft.dm.dw/atlas"]).toBe("for atlas");
    rerender({ k: draftKey.dm("local/scout") });
    expect(result.current[0]).toBe("half a thought");
    // Emptied: no draft.
    act(() => result.current[1](""));
    expect(file["draft.dm.local/scout"]).toBeUndefined();
  });

  it("a room's message survives the room closing, and goes once it's sent", async () => {
    const first = render(<RoomView room={room} />);
    type(screen.getByRole("combobox") as HTMLTextAreaElement, "ship it?");
    first.unmount();
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(file["draft.room.r1"]).toBe("ship it?");
    render(<RoomView room={room} />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    expect(box.value).toBe("ship it?");
    fireEvent.keyDown(box, { key: "Enter" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(said).toEqual(["ship it?"]);
    expect(box.value).toBe("");
    expect(deskState.get("draft.room.r1")).toBeUndefined();
    expect(file["draft.room.r1"]).toBeUndefined();
  });

  it("a message the hub didn't take stays as the draft", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RoomView room={room} />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    type(box, "fails");
    fireEvent.keyDown(box, { key: "Enter" });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(box.value).toBe("fails");
    expect(file["draft.room.r1"]).toBe("fails");
  });
});

describe("a room's thread", () => {
  it("comes back open with its own draft", async () => {
    useDesk.setState({ timelines: { r1: [message("m1"), message("m2", "m1")] } });
    useUi.setState({ roomThreads: { r1: "m1" } });
    deskState.set(draftKey.room("r1", "m1"), "a reply");
    render(
      <>
        <RoomView room={room} />
        <ThreadPanel room={room} thread="m1" />
      </>,
    );
    const thread = screen.getByRole("complementary", { name: "Thread" });
    expect(thread.textContent).toContain("message m2");
    const boxes = screen.getAllByRole("combobox") as HTMLTextAreaElement[];
    expect(boxes.map((b) => b.value)).toEqual(["", "a reply"]);
    fireEvent.click(screen.getByRole("button", { name: "Close the thread" }));
    expect(useUi.getState().roomThreads).toEqual({});
  });
});

describe("unsaved file changes", () => {
  it("are kept while unsaved, put back over the file when it's next read, and forgotten once saved", async () => {
    const stop = keepFileDrafts();
    const { put } = useDrafts.getState();
    put("local/scout", "SOUL.md", opened("calm", null));
    put("local/scout", "SOUL.md", edited(opened("calm", null), "calm and kind"));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(file["draft.file.local/scout/SOUL.md"]).toEqual({ text: "calm and kind", saved: "calm" });
    // Desk restarts: the file is read again, and the changes go back over it.
    const reread = withKeptChanges(opened("calm", null), "local/scout", "SOUL.md");
    expect(reread).toMatchObject({ text: "calm and kind", saved: "calm" });
    put("local/scout", "SOUL.md", saved(reread, "calm and kind", "now"));
    expect(deskState.get("draft.file.local/scout/SOUL.md")).toBeUndefined();
    expect(withKeptChanges(opened("x", null), "local/scout", "SOUL.md").text).toBe("x");
    stop();
  });
});

describe("a conversation's scroll position", () => {
  /** A pane 100px tall at the window's top, with messages 50px tall. */
  const pane = (scrollTop: number, ids: string[]) => {
    const el = document.createElement("div");
    Object.defineProperties(el, {
      scrollHeight: { value: ids.length * 50 },
      clientHeight: { value: 100 },
    });
    el.scrollTop = scrollTop;
    el.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
    ids.forEach((id, i) => {
      const m = document.createElement("article");
      m.dataset.messageId = id;
      m.getBoundingClientRect = () => ({ top: i * 50 - el.scrollTop, bottom: i * 50 + 50 - el.scrollTop }) as DOMRect;
      el.append(m);
    });
    return el;
  };
  const ids = ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"];

  it("is kept only when scrolled up from the newest message", () => {
    expect(anchorOf(pane(300, ids))).toBeNull();
    expect(anchorOf(pane(110, ids))).toEqual({ id: "m2", offset: -10 });
  });

  it("puts the same message back where it was, once it's there", () => {
    const later = pane(0, ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
    expect(applyAnchor(later, { id: "m2", offset: -10 })).toBe(true);
    expect(later.scrollTop).toBe(110);
    expect(applyAnchor(pane(0, ["m9"]), { id: "m2", offset: 0 })).toBe(false);
  });
});
