import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { createGrid, startGrids, useGrids } from "../grids/store";
import { useDesk } from "../hub/store";
import type { Room } from "../hub/types";
import { useRoomOrder } from "../rooms/order";
import { useSettings } from "../settings/store";
import { DEFAULT_SHORTCUTS } from "../shortcuts/keys";
import { Sidebar, scrollEdges } from "./Sidebar";
import { useUi } from "./ui";
import { useChat } from "../chat/store";
import { servePictures } from "../pictures/testing";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

afterEach(cleanup);

const none = () => {};
const sidebar = (on: Partial<Record<"onNewRoom" | "onSettings" | "onNewSession" | "onNewCrew", () => void>> = {}) =>
  render(<Sidebar onAsk={none} onNewSession={on.onNewSession ?? none} onNewRoom={on.onNewRoom ?? none} onNewCrew={on.onNewCrew ?? none} onSettings={on.onSettings ?? none} />);

const kept = new Map<string, unknown>();
const memory = (): GridStorage =>
  ({ get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} }) as GridStorage;

beforeEach(() => {
  kept.clear();
  useRoomOrder.setState({ order: [] });
  useSettings.setState({ shortcuts: {}, keys: DEFAULT_SHORTCUTS, groups: [], sessionNames: {} });
  useDesk.setState({ view: "floor", rooms: {}, sessions: {} });
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
});

describe("Sidebar", () => {
  it("shows each shortcut's configured keys", () => {
    sidebar();
    expect(screen.getByRole("button", { name: /Ask anyone/ }).textContent).toBe("Ask anyone ⌃⇧K");
    expect(screen.getByRole("button", { name: "New session" }).textContent).toBe("New session ⌘N");
    expect(screen.getByRole("button", { name: /^Settings/ }).textContent).toBe("Settings ⌘,");
    cleanup();
    useSettings.getState().set({ shortcuts: { ask: "Alt+Space", newSession: "Super+J", settings: "Control+Alt+Comma" } });
    sidebar();
    expect(screen.getByRole("button", { name: /Ask anyone/ }).textContent).toBe("Ask anyone ⌥Space");
    expect(screen.getByRole("button", { name: "New session" }).textContent).toBe("New session ⌘J");
    expect(screen.getByRole("button", { name: /^Settings/ }).textContent).toBe("Settings ⌃⌥,");
  });

  it("keeps Ask anyone and the views at the top, the actions, voice and look at the bottom, and scrolls the rest", () => {
    const { container } = sidebar();
    const top = container.querySelector(".side-top")!;
    const middle = container.querySelector(".side-scroll")!;
    const foot = container.querySelector(".side-foot")!;
    expect(within(top as HTMLElement).getByRole("button", { name: /Ask anyone/ })).toBeTruthy();
    expect(within(top as HTMLElement).getByRole("tablist", { name: "View" })).toBeTruthy();
    expect(within(middle as HTMLElement).getByRole("region", { name: "Rooms" })).toBeTruthy();
    expect(within(middle as HTMLElement).getByRole("region", { name: "Groups" })).toBeTruthy();
    const actions = within(foot as HTMLElement).getAllByRole("button").filter((b) => b.classList.contains("side-btn"));
    expect(actions.map((b) => b.querySelector(".side-btn-label")!.textContent)).toEqual(["New session", "New crew member", "Settings"]);
    // One button style for all three, Settings included.
    expect(actions.every((b) => b.className === "btn side-btn")).toBe(true);
    expect(within(foot as HTMLElement).getByRole("radiogroup", { name: "Look" })).toBeTruthy();
    // Nothing that's meant to stay put is inside what scrolls.
    for (const el of [top, foot]) expect(middle.contains(el)).toBe(false);
    expect([...container.querySelector(".sidebar")!.children].map((c) => c.className)).toEqual(["side-top", "side-mid", "side-foot"]);
  });

  it("shows the fade at an edge only while there's more that way", () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 })).toEqual({ above: false, below: false });
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 900, clientHeight: 400 })).toEqual({ above: false, below: true });
    expect(scrollEdges({ scrollTop: 500, scrollHeight: 900, clientHeight: 400 })).toEqual({ above: true, below: false });
    const { container } = sidebar();
    const middle = container.querySelector<HTMLElement>(".side-scroll")!;
    Object.defineProperty(middle, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(middle, "clientHeight", { configurable: true, value: 400 });
    middle.scrollTop = 0;
    fireEvent.scroll(middle);
    expect(middle.hasAttribute("data-more-above")).toBe(false);
    expect(middle.hasAttribute("data-more-below")).toBe(true);
    middle.scrollTop = 200;
    fireEvent.scroll(middle);
    expect(middle.hasAttribute("data-more-above")).toBe(true);
    expect(middle.hasAttribute("data-more-below")).toBe(true);
    middle.scrollTop = 500;
    fireEvent.scroll(middle);
    expect(middle.hasAttribute("data-more-below")).toBe(false);
  });

  it("puts back where its middle was scrolled, and keeps it as `sidebar`", async () => {
    vi.useFakeTimers();
    const tall = { configurable: true, value: 2000 };
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(tall.value);
    useUi.setState({ scroll: { sidebar: 340 } });
    const { container } = sidebar();
    const middle = container.querySelector<HTMLElement>(".side-scroll")!;
    expect(middle.scrollTop).toBe(340);
    middle.scrollTop = 120;
    fireEvent.scroll(middle);
    await act(async () => void vi.advanceTimersByTime(400));
    expect(useUi.getState().scroll.sidebar).toBe(120);
    scrollHeight.mockRestore();
    vi.useRealTimers();
  });

  it("has a + for a new room, as Groups has", () => {
    const onNewRoom = vi.fn();
    sidebar({ onNewRoom });
    const rooms = screen.getByRole("region", { name: "Rooms" });
    const plus = within(rooms).getByRole("button", { name: "New room" });
    expect(plus.className).toBe(within(screen.getByRole("region", { name: "Groups" })).getByRole("button", { name: "New group" }).className);
    fireEvent.click(plus);
    expect(onNewRoom).toHaveBeenCalled();
  });
});

describe("grids in the sidebar", () => {
  const gridRows = () =>
    within(screen.getByRole("list", { name: "Grids" }))
      .getAllByRole("button")
      .filter((b) => b.classList.contains("gi"))
      .map((b) => b.querySelector(".gi-name")?.textContent);
  const gridRow = (name: string) => within(screen.getByRole("list", { name: "Grids" })).getAllByRole("button").find((b) => b.querySelector(".gi-name")?.textContent === name)!;

  beforeEach(() => useDesk.setState({ view: "grids" }));

  it("makes a new grid from the + in its header", () => {
    sidebar();
    const grids = screen.getByRole("region", { name: "Grids" });
    expect(within(grids).queryByText(/\+ New grid/)).toBeNull();
    fireEvent.click(within(grids).getByRole("button", { name: "New grid" }));
    expect(gridRows()).toEqual(["Main", "Grid 2"]);
  });

  it("renames a grid in place by double-click, F2 or its menu: Enter saves, Escape cancels", () => {
    sidebar();
    fireEvent.doubleClick(gridRow("Main"));
    let field = screen.getByRole("textbox", { name: "Grid name" });
    fireEvent.change(field, { target: { value: "Release" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(gridRows()).toEqual(["Main"]);

    fireEvent.keyDown(gridRow("Main"), { key: "F2" });
    field = screen.getByRole("textbox", { name: "Grid name" });
    fireEvent.change(field, { target: { value: "Release" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(gridRows()).toEqual(["Release"]);
    expect((kept.get(`grid.${MAIN_GRID}`) as { name: string }).name).toBe("Release");

    fireEvent.contextMenu(gridRow("Release"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename grid/ }));
    field = screen.getByRole("textbox", { name: "Grid name" });
    fireEvent.change(field, { target: { value: "Ops" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(gridRows()).toEqual(["Ops"]);
  });

  it("reorders grids with Alt+↑/↓, kept in grid.index", () => {
    act(() => {
      createGrid();
      createGrid();
    });
    sidebar();
    expect(gridRows()).toEqual(["Main", "Grid 2", "Grid 3"]);
    fireEvent.keyDown(gridRow("Main"), { key: "ArrowDown", altKey: true });
    expect(gridRows()).toEqual(["Grid 2", "Main", "Grid 3"]);
    expect((kept.get("grid.index") as { order: string[] }).order).toEqual(useGrids.getState().order);
    fireEvent.keyDown(gridRow("Grid 3"), { key: "ArrowDown", altKey: true });
    expect(gridRows()).toEqual(["Grid 2", "Main", "Grid 3"]);
  });

  it("draws grid rows as a group's items are: the grip, the indent, and the ⋯ beside them", () => {
    act(() => void createGrid());
    useSettings.setState({ groups: [{ id: "g1", name: "Team", collapsed: false, items: [] }] });
    const { container } = sidebar();
    const row = gridRow("Main");
    const item = container.querySelector<HTMLElement>(".groups .grp-items");
    // The same list, row and grip as a group's items.
    expect(row.closest("ul")!.className).toBe(item!.className);
    expect(row.closest("ul")!.parentElement!.className).toBe("grp");
    expect(row.className.split(" ")[0]).toBe("gi");
    expect(row.firstElementChild!.className).toBe("gi-handle");
    expect(row.querySelector(".gi-handle svg")).toBeTruthy();
    expect(row.closest("li")!.classList.contains("gi-wrap")).toBe(true);
    // Its ⋯ still opens its menu.
    const more = screen.getByRole("button", { name: "Main options" });
    expect(more.closest("li")).toBe(row.closest("li"));
    fireEvent.click(more);
    expect(screen.getByRole("menuitem", { name: /Rename grid/ })).toBeTruthy();
  });

  it("marks each grid's row as a place to drop a pane", () => {
    sidebar();
    expect(gridRow("Main").closest("[data-drop-grid-row]")?.getAttribute("data-drop-grid-row")).toBe(MAIN_GRID);
  });
});

describe("rooms in the sidebar", () => {
  const room = (id: string, name: string, createdAt: string) => ({ id, slug: id, name, members: [], defaultMember: null, createdAt, updatedAt: createdAt }) as Room;
  const roomRows = () =>
    within(screen.getByRole("list", { name: "Rooms" }))
      .getAllByRole("button")
      .filter((b) => b.classList.contains("gi"))
      .map((b) => b.querySelector(".gi-name")?.textContent);
  const roomRow = (name: string) => within(screen.getByRole("list", { name: "Rooms" })).getAllByRole("button").find((b) => b.querySelector(".gi-name")?.textContent === name)!;

  beforeEach(() =>
    useDesk.setState({
      view: "rooms",
      loaded: true,
      rooms: { r1: room("r1", "Launch", "2026-01-01"), r2: room("r2", "Design", "2026-02-01"), r3: room("r3", "Ops", "2026-03-01") },
    }),
  );

  it("draws rooms as a group's items are, with the grip and the ⋯", () => {
    sidebar();
    const row = roomRow("Launch");
    expect(row.firstElementChild!.className).toBe("gi-handle");
    expect(row.closest("ul")!.className).toBe("grp-items");
    expect(screen.getByRole("button", { name: "Launch options" }).closest("li")).toBe(row.closest("li"));
  });

  it("lists rooms in the order they were put in, new ones last, and moves them with Alt+↑/↓", () => {
    useRoomOrder.setState({ order: ["r3", "r1"] });
    sidebar();
    expect(roomRows()).toEqual(["Ops", "Launch", "Design"]);
    fireEvent.keyDown(roomRow("Ops"), { key: "ArrowDown", altKey: true });
    expect(roomRows()).toEqual(["Launch", "Ops", "Design"]);
    expect(useRoomOrder.getState().order).toEqual(["r1", "r3", "r2"]);
    fireEvent.keyDown(roomRow("Launch"), { key: "ArrowUp", altKey: true });
    expect(roomRows()).toEqual(["Launch", "Ops", "Design"]);
    expect(screen.getByText("Already the first room")).toBeTruthy();
    act(() => useDesk.setState((s) => ({ rooms: { ...s.rooms, r4: room("r4", "Alpha", "2026-04-01") } })));
    expect(roomRows()).toEqual(["Launch", "Ops", "Design", "Alpha"]);
  });
});

describe("deleting from the sidebar", () => {
  it("deletes a room from its ⋯ menu once you confirm", async () => {
    const deleteRoom = vi.fn(() => Promise.resolve());
    const room = { id: "r1", name: "Launch", members: [] } as unknown as ReturnType<typeof useDesk.getState>["rooms"][string];
    useDesk.setState({ view: "rooms", rooms: { r1: room }, activeRoom: "r1", hub: { deleteRoom } as never });
    useRoomOrder.setState({ order: ["r1"] });
    sidebar();
    fireEvent.click(screen.getByRole("button", { name: "Launch options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete room…" }));
    expect(deleteRoom).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete room" })));
    expect(deleteRoom).toHaveBeenCalledWith("r1");
    expect(useDesk.getState().rooms).toEqual({});
    expect(useDesk.getState().activeRoom).toBeNull();
    expect(useRoomOrder.getState().order).not.toContain("r1");
  });

  it("deletes a grid, even the last one, leaving none: the Grids section keeps its + and says so", () => {
    useDesk.setState({ view: "grids" });
    sidebar();
    expect(useGrids.getState().order).toHaveLength(1);
    const was = useGrids.getState().order[0]!;
    fireEvent.click(screen.getByRole("button", { name: `${useGrids.getState().grids[was]!.name} options` }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete grid…" }));
    expect(useGrids.getState().order).toEqual([]);
    expect(useGrids.getState().active).toBeNull();
    expect(kept.get("grid.index")).toEqual({ order: [] });
    expect(kept.has(`grid.${was}`)).toBe(false);
    const grids = screen.getByRole("region", { name: "Grids" });
    expect(within(grids).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["New grid"]);
    expect(within(grids).getByText("No grids yet")).toBeTruthy();
    // + makes one again.
    fireEvent.click(within(grids).getByRole("button", { name: "New grid" }));
    expect(useGrids.getState().order).toHaveLength(1);
    expect(within(grids).queryByText("No grids yet")).toBeNull();
  });

  it("shows agents with their pictures, and you round at the bottom, opening your Profile", async () => {
    servePictures();
    const local = { id: "local", label: "This Mac", url: "http://127.0.0.1:1", local: true, token: "t" };
    useChat.setState({
      hubs: [local],
      roster: [{ hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false, picture: { version: "v1", source: "chosen", at: "" } }],
      me: { local: { id: "u1", name: "Sam", picture: { version: "m1", source: "chosen", at: "" } } },
    });
    const { container } = sidebar();
    const groups = within(container.querySelector(".side-scroll") as HTMLElement).getByRole("region", { name: "Groups" });
    await vi.waitFor(() => expect(within(groups).getByText("Scout").closest(".gi-wrap")!.querySelector(".mark img")).toBeTruthy());
    const you = screen.getByRole("button", { name: /Sam/ });
    await vi.waitFor(() => expect(you.querySelector(".mark-person img")).toBeTruthy());
    fireEvent.click(you);
    expect(useUi.getState().settings).toBe("profile");
    vi.unstubAllGlobals();
  });
});
