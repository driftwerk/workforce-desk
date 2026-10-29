import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { createGrid, startGrids, useGrids } from "../grids/store";
import { useDesk } from "../hub/store";
import { useSettings } from "../settings/store";
import { DEFAULT_SHORTCUTS } from "../shortcuts/keys";
import { Sidebar, scrollEdges } from "./Sidebar";
import { useUi } from "./ui";

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
      .map((b) => b.querySelector(".side-name")?.textContent);
  const gridRow = (name: string) => within(screen.getByRole("list", { name: "Grids" })).getAllByRole("button").find((b) => b.querySelector(".side-name")?.textContent === name)!;

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

  it("marks each grid's row as a place to drop a pane", () => {
    sidebar();
    expect(gridRow("Main").closest("[data-drop-grid-row]")?.getAttribute("data-drop-grid-row")).toBe(MAIN_GRID);
  });
});
