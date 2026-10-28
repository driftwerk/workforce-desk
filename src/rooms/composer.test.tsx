import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const said: string[] = [];
vi.mock("./engine", () => ({
  say: vi.fn(async (_room: unknown, text: string) => void said.push(text)),
  prune: () => {},
}));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { RoomView } = await import("./RoomView");

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
      { id: "local", label: "This Mac", url: "http://127.0.0.1:1", local: true, token: "t" },
      { id: "dw", label: "Driftwerk", url: "https://dw", local: false, token: "t" },
    ],
    roster: [
      { hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false },
      { hubId: "dw", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false },
    ],
  });
  useDesk.setState({ rooms: { r1: room }, timelines: { r1: [] }, roomWorking: {} });
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
    type(box, "hey @la");
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("puts the one you pick into the message, then Enter sends", async () => {
    render(<RoomView room={room} />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    type(box, "@la");
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
