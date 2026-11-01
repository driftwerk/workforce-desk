import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Desk's two composers, a DM's and a room's (a thread's is the room's), with
// emoji in them: each sends what it shows.

vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));
const said: string[] = [];
vi.mock("../rooms/engine", () => ({
  say: vi.fn(async (_room: unknown, text: string) => void said.push(text)),
  prune: () => {},
  retry: () => {},
  dismiss: () => {},
  answerPrompt: () => true,
  answerForm: vi.fn(async () => {}),
}));

const { emptyConversation } = await import("../chat/conversation");
const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useSettings } = await import("../settings/store");
const { Rooms } = await import("../rooms/Rooms");
const { RoomView } = await import("../rooms/RoomView");
const { loadEmoji } = await import("./data");

HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
Element.prototype.scrollIntoView = () => {};

const room = {
  id: "r1",
  slug: "release",
  name: "release",
  members: [{ hub: "local", agent: "scout" }],
  defaultMember: "local/scout",
  createdAt: "",
  updatedAt: "",
};
const send = vi.fn((_to: string, _text: string) => true);

/** Each character as the browser types it, unless the page took the key. */
const type = (el: HTMLTextAreaElement, text: string) => {
  for (const ch of text) {
    if (!fireEvent.keyDown(el, { key: ch })) continue;
    const at = el.selectionStart;
    const value = el.value.slice(0, at) + ch + el.value.slice(el.selectionEnd);
    fireEvent.change(el, { target: { value, selectionStart: at + 1, selectionEnd: at + 1 } });
  }
};

beforeAll(async () => {
  await loadEmoji();
}, 30_000);
beforeEach(() => {
  said.length = 0;
  send.mockClear();
  useSettings.setState({ emoticons: true });
  useChat.setState({
    hubs: [
      { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" },
      { id: "dw", label: "Driftwerk", url: "https://dw", local: false, revision: "t" },
    ],
    roster: [
      { hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false },
      { hubId: "dw", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false },
    ],
    activeAgent: "dw/atlas",
    conversations: { "dw/atlas": { ...emptyConversation(), connected: true } },
    histories: {},
    send,
  });
  useDesk.setState({ activeRoom: null, hub: null, rooms: { r1: room }, timelines: { r1: [] }, roomDrafts: {} });
});
afterEach(cleanup);

describe("a DM's composer", () => {
  it("turns emoticons into emoji and sends them so", () => {
    render(<Rooms />);
    const box = screen.getByPlaceholderText("Message Atlas") as HTMLTextAreaElement;
    type(box, "thanks <3 see you :)");
    expect(box.value).toBe("thanks ❤️ see you :)");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(send).toHaveBeenCalledWith("dw/atlas", "thanks ❤️ see you 🙂");
  });

  it("has the emoji button, and a :shortcode list it says is open", () => {
    render(<Rooms />);
    const box = screen.getByPlaceholderText("Message Atlas") as HTMLTextAreaElement;
    expect(screen.getByRole("button", { name: "Add an emoji" })).toBeTruthy();
    type(box, "ship :rocke");
    expect(box.getAttribute("role")).toBe("combobox");
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(box.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]!.id);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("ship 🚀");
    expect(send).not.toHaveBeenCalled();
    expect(box.getAttribute("role")).toBeNull();
  });
});

describe("a room's composer", () => {
  it("sends emoticons as emoji", async () => {
    render(<RoomView room={room} />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    type(box, "ship it (y)");
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(said).toEqual(["ship it 👍"]);
  });

  it("keeps the @ list and the :shortcode list apart", () => {
    render(<RoomView room={room} />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    type(box, "@at");
    expect(screen.getByRole("listbox", { name: "Mention someone" })).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("@atlas ");
    act(() => box.setSelectionRange(7, 7));
    fireEvent.select(box);
    type(box, ":tad");
    expect(screen.queryByRole("listbox", { name: "Mention someone" })).toBeNull();
    const list = screen.getByRole("listbox", { name: "Emoji" });
    expect(box.getAttribute("aria-controls")).toBe(list.id);
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe("@atlas 🎉");
    expect(said).toEqual([]);
  });
});
