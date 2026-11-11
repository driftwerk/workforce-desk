// Putting things in a grid: an empty pane's picker, "Put in a grid ›" on a
// room's, a board's and a group's sidebar row, and those rows' "in a grid"
// marks.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../hub/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()), emit: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("../session/Terminal", () => ({ Terminal: () => null }));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../floor/Floor", async (real) => ({ ...(await real<object>()), useFloorReads: () => {} }));

const { useDesk } = await import("../hub/store");
const { useChat } = await import("../chat/store");
const { useBoard } = await import("../board/store");
const { useSettings } = await import("../settings/store");
const { useOverview } = await import("../overview/store");
const { GridCanvas } = await import("./GridView");
const { MAIN_GRID } = await import("./model");
const { createGrid, deliver, layOut, startGrids, useGrids } = await import("./store");
const { putInGrid, whereInGrid, InGridRow, openFromRow } = await import("./putIn");
const { roomItem, boardItem } = await import("./where");
const { ACME } = await import("../board/testing");
const { hub } = await import("../floor/testing");
type GridStorage = import("./storage").GridStorage;
type PaneContent = import("./engine").PaneContent;
type MenuEntry = import("../ui/Menu").MenuEntry;

Element.prototype.scrollIntoView = () => {};

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};
const room = (id: string, name: string) => ({ id, slug: id, name, channel: `desk:${id}`, members: [{ hub: "local", agent: "allan" }], defaultMember: null, createdAt: "", updatedAt: "" });

beforeEach(() => {
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null, filled: {} });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  useChat.setState({ hubs: [hub("local")], roster: [{ hubId: "local", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }] });
  useDesk.setState({
    view: "grids",
    loaded: true,
    connected: false,
    hub: null,
    openId: null,
    sessions: { s1: { id: "s1", name: "acme-api", engine: "claude", state: "working", live: true, origin: "desk", cwd: "/w", createdAt: "", updatedAt: "" } as Session },
    rooms: { r1: room("r1", "Engineering"), r2: room("r2", "Release watch") },
    timelines: {},
    windows: {},
  });
  useBoard.setState({ supported: true, boards: { [ACME.id]: { ...ACME, name: "Storefront" } }, tickets: {}, open: null });
  useSettings.setState({ groups: [{ id: "g-platform", name: "Platform", collapsed: false, items: ["session:s1"] }], ungrouped: { collapsed: false, items: [] } });
  useOverview.setState({ overview: null });
});
afterEach(cleanup);

const grid = () => useGrids.getState().grids[MAIN_GRID]!;
function Canvas() {
  const g = useGrids((s) => s.grids[MAIN_GRID]!);
  return <GridCanvas grid={g} />;
}
const picker = () => screen.getByRole("group", { name: "What goes in this pane?" });
const tab = (name: string) => fireEvent.click(within(picker()).getByRole("tab", { name }));
const row = (name: RegExp) => within(picker()).getByRole("button", { name });

describe("an empty pane's picker", () => {
  it("has a tab for each kind, rooms, boards and the Floor among them", () => {
    render(<Canvas />);
    expect(within(picker()).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Sessions", "Agents", "Terminal", "Rooms", "Boards", "Floor"]);
    expect(row(/acme-api/)).toBeTruthy();
    tab("Rooms");
    expect(row(/Engineering/).textContent).toBe("EngineeringAllan, you");
    tab("Boards");
    expect(row(/Storefront/)).toBeTruthy();
    tab("Floor");
    expect(within(picker()).getAllByRole("button").map((b) => b.querySelector(".gpick-name")?.textContent)).toEqual(["Everything", "Floor › Platform"]);
  });

  it("puts what's chosen in this pane", () => {
    render(<Canvas />);
    tab("Rooms");
    fireEvent.click(row(/Release watch/));
    expect(grid().panes.map((p) => p.content)).toEqual([{ kind: "room", room: "r2" }]);
    expect(screen.getByRole("region", { name: "Release watch" })).toBeTruthy();
  });

  it("greys out what's in this grid already", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "room", room: "r1" });
    render(<Canvas />);
    tab("Rooms");
    const there = row(/Engineering/);
    expect(there.textContent).toBe("Engineeringalready in this grid");
    expect((there as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(there);
    expect(grid().panes.filter((p) => p.content).length).toBe(1);
    expect((row(/Release watch/) as HTMLButtonElement).disabled).toBe(false);
  });

  it("searches every kind at once, saying what each is; Enter takes the first", () => {
    render(<Canvas />);
    const search = within(picker()).getByRole("textbox", { name: "Search" });
    fireEvent.change(search, { target: { value: "store" } });
    expect(within(picker()).queryByRole("tablist")).toBeNull();
    expect(within(picker()).getAllByRole("listitem").map((b) => b.textContent)).toEqual(["StorefrontBoard · ACM"]);
    fireEvent.change(search, { target: { value: "platform" } });
    expect(within(picker()).getAllByRole("listitem").map((b) => b.textContent)).toEqual(["Floor › PlatformFloor · one group"]);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(grid().panes.map((p) => p.content)).toEqual([{ kind: "floor", group: "g-platform" }]);
  });

  it("opens a terminal from its Terminal tab", () => {
    render(<Canvas />);
    tab("Terminal");
    fireEvent.click(row(/New terminal/));
    expect(grid().panes.map((p) => p.content)).toEqual([{ kind: "terminal", terminalId: null }]);
  });
});

describe("a pane's Replace menu", () => {
  it("offers rooms, boards and the Floor too", () => {
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    render(<Canvas />);
    fireEvent.click(screen.getByRole("button", { name: "Pane options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Replace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Floor" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Platform" }));
    expect(grid().panes.map((p) => p.content)).toEqual([{ kind: "floor", group: "g-platform" }]);
  });
});

describe("Put in a grid ›, from a room's, a board's or a group's row", () => {
  const room1: PaneContent = { kind: "room", room: "r1" };
  const item = (e: MenuEntry) => (e.kind === "item" ? e : null)!;

  it("lists each grid with where it would go there, then a new grid", () => {
    const release = createGrid();
    layOut(release, "halves");
    deliver(release, { kind: "session", sessionId: "s1" });
    deliver(release, { kind: "floor" });
    const third = createGrid();
    deliver(third, room1);
    const entry = item(putInGrid(room1));
    expect(entry.label).toBe("Put in a grid");
    expect(entry.submenu!.map((e) => (e.kind === "item" ? `${e.label}${e.hint ? ` · ${e.hint}` : ""}` : "—"))).toEqual([
      "Main · the empty pane",
      "Grid 2 · adds a pane",
      "Grid 3 · already in it",
      "—",
      "A new grid",
    ]);
    expect(whereInGrid(grid().panes, room1)).toBe("the empty pane");
  });

  it("puts it there and shows it; a new grid is made for it", () => {
    act(() => item(item(putInGrid(room1)).submenu![0]!).onSelect!());
    expect(grid().panes.map((p) => p.content)).toEqual([room1]);
    expect(useDesk.getState().view).toBe("grids");
    const before = useGrids.getState().order.length;
    act(() => item(item(putInGrid({ kind: "board", board: ACME.id })).submenu!.at(-1)!).onSelect!());
    const order = useGrids.getState().order;
    expect(order.length).toBe(before + 1);
    expect(useGrids.getState().grids[order.at(-1)!]!.panes.map((p) => p.content)).toEqual([{ kind: "board", board: ACME.id }]);
    expect(useGrids.getState().active).toBe(order.at(-1));
  });

  it("marks the row while it's in a grid", () => {
    deliver(MAIN_GRID, room1);
    render(
      <>
        <InGridRow item={roomItem("r1")} row={(mark, id) => <span data-testid="r1" aria-describedby={id ?? undefined}>{mark}</span>} />
        <InGridRow item={boardItem(ACME.id)} row={(mark, id) => <span data-testid="board" aria-describedby={id ?? undefined}>{mark}</span>} />
      </>,
    );
    const r1 = screen.getByTestId("r1");
    expect(document.getElementById(r1.getAttribute("aria-describedby")!)?.textContent).toBe("In grid Main");
    expect(screen.getByTestId("board").getAttribute("aria-describedby")).toBeNull();
    act(() => deliver(MAIN_GRID, { kind: "board", board: ACME.id }));
    const board = screen.getByTestId("board");
    expect(document.getElementById(board.getAttribute("aria-describedby")!)?.textContent).toBe("In grid Main");
  });
});

describe("a room's or a board's row, clicked", () => {
  it("in the Grids view, shows it where a grid has it; else opens it as always", () => {
    const other = createGrid();
    deliver(other, { kind: "board", board: ACME.id });
    useGrids.setState({ active: MAIN_GRID });
    const open = vi.fn();
    openFromRow({ kind: "board", board: ACME.id }, open);
    expect(open).not.toHaveBeenCalled();
    expect(useGrids.getState().active).toBe(other);
    // In no grid: opened.
    openFromRow({ kind: "room", room: "r1" }, open);
    expect(open).toHaveBeenCalledTimes(1);
    // Outside the Grids view, a row opens its own view, grid or not.
    useDesk.setState({ view: "rooms" });
    openFromRow({ kind: "board", board: ACME.id }, open);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("the picker in a small pane, in grids.css", () => {
  it("drops its card, title and footnote below 320px high, so the list keeps the room", async () => {
    const fs = (await import("node:fs" as string)) as { readFileSync: (path: string, enc: "utf8") => string };
    const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
    const css = fs.readFileSync(`${cwd}/src/styles/grids.css`, "utf8");
    expect(css).toMatch(/\.gpane-vacant \.gpane-body \{\s*container: gpane \/ size;/);
    expect(css).toMatch(/@container gpane \(max-height: 320px\) \{[\s\S]*?\.gpick-title,\s*\.gpick-foot \{\s*display: none;/);
  });
});
