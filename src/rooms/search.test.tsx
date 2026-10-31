import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: unknown }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useUi } = await import("../shell/ui");
const { SearchPanel, SEARCH_DEBOUNCE_MS } = await import("./SearchPanel");

const room = { id: "r1", slug: "release", name: "Release", members: [], defaultMember: null, createdAt: "", updatedAt: "" };
const reply = { id: "m9", roomId: "r1", threadId: "t1", author: "local/allan", content: "the rollback note", hop: 0, createdAt: "2026-10-27T10:09:00Z" };
const search = vi.fn(async () => [{ roomId: "r1", message: reply, snippet: "the rollback note" }]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  search.mockClear();
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "", local: true, token: "" }],
    roster: [{ hubId: "local", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
  });
  useUi.setState({ search: { text: "from:@allan rollback" }, roomThreads: {}, flash: null });
  useDesk.setState({
    rooms: { r1: room },
    timelines: {},
    hub: { search } as never,
    reveal: vi.fn(async () => ({ thread: "t1" })),
    openRoom: vi.fn(async () => {}),
  } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)));

describe("search", () => {
  it("asks the hub once typing settles, and the Filters write the same text", async () => {
    render(<SearchPanel />);
    await settle();
    expect(search).toHaveBeenCalledWith({ q: "rollback", from: "local/allan", has: [], inThread: false });
    fireEvent.click(screen.getByRole("button", { name: "In ▾" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Release" }));
    expect((screen.getByRole("textbox", { name: "Search messages" }) as HTMLInputElement).value).toBe("from:@allan in:#release rollback");
    fireEvent.click(screen.getByRole("button", { name: "In a thread" }));
    expect(useUi.getState().search?.text).toBe("from:@allan in:#release is:thread rollback");
    await settle();
    expect(search).toHaveBeenLastCalledWith({ q: "rollback", from: "local/allan", room: "r1", has: [], inThread: true });
  });

  it("marks the matches, and opens a reply in its thread, flashing it", async () => {
    render(<SearchPanel />);
    await settle();
    expect(screen.getByText("rollback").tagName).toBe("MARK");
    fireEvent.click(screen.getByRole("button", { name: /rollback/ }));
    await act(async () => void (await vi.runAllTimersAsync()));
    expect(useUi.getState().roomThreads).toEqual({ r1: "t1" });
    expect(useUi.getState().flash).toMatchObject({ id: "m9" });
    expect(useUi.getState().search).not.toBeNull();
  });

  it("lets go of a search on its way once the field is cleared", async () => {
    let answer: (hits: unknown[]) => void = () => {};
    search.mockImplementationOnce(() => new Promise((r) => (answer = r as never)));
    render(<SearchPanel />);
    await settle();
    act(() => useUi.getState().setSearch(""));
    await act(async () => answer([{ roomId: "r1", message: reply, snippet: "the rollback note" }]));
    expect(screen.queryByRole("list", { name: "Results" })).toBeNull();
    expect(screen.getByText(/Search messages in your rooms/)).toBeTruthy();
  });

  it("says what a filter names nothing, and closes on Escape", () => {
    useUi.setState({ search: { text: "from:@bob" } });
    render(<SearchPanel />);
    expect(screen.getByRole("alert").textContent).toBe("No one in your crew is called @bob");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search messages" }), { key: "Escape" });
    expect(useUi.getState().search).toBeNull();
  });
});
