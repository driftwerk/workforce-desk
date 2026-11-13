import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clampSide, SIDE_MAX, SIDE_MIN, SIDE_WIDTH, useSideFoot, useSideWidth } from "./sideWidth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { createGrid, startGrids, useGrids } from "../grids/store";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { Room } from "../hub/types";
import { useRoomOrder } from "../rooms/order";
import { useSettings } from "../settings/store";
import { defaultShortcuts } from "../shortcuts/keys";
import { Sidebar, scrollEdges } from "./Sidebar";
import { reloadSections, SECTIONS_KEY } from "./SideSection";
import { useBoard } from "../board/store";
import { useBoardOrder } from "../board/order";
import { ACME, ticket } from "../board/testing";
import { useUi } from "./ui";
import { servePictures } from "../pictures/testing";
import { useFloor } from "../floor/store";
import { agent, need, ready, session as asker, view as floorView } from "../floor/testing";
import type { Session } from "../hub/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

afterEach(cleanup);

const none = () => {};
const sidebar = (on: Partial<Record<"onNewRoom" | "onSettings" | "onNewSession" | "onNewCrew", () => void>> = {}) =>
  render(<Sidebar onAsk={none} onNewSession={on.onNewSession ?? none} onNewRoom={on.onNewRoom ?? none} onNewCrew={on.onNewCrew ?? none} onSettings={on.onSettings ?? none} />);

const kept = new Map<string, unknown>();
const memory = (): GridStorage =>
  ({ get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} }) as GridStorage;

const GLOBEX = { ...ACME, id: "b-globex", name: "Globex", prefix: "GLX", createdAt: "2026-11-02T09:00:00Z" };

beforeEach(() => {
  kept.clear();
  localStorage.clear();
  useSideFoot.setState({ open: true });
  useSideWidth.setState({ width: SIDE_WIDTH });
  localStorage.removeItem(SECTIONS_KEY);
  reloadSections();
  useBoardOrder.setState({ order: [] });
  useBoard.setState({ boards: {}, tickets: {}, supported: null, shown: null, open: null });
  useRoomOrder.setState({ order: [] });
  useSettings.setState({ shortcuts: {}, keys: defaultShortcuts(), groups: [], sessionNames: {} });
  useDesk.setState({ view: "floor", rooms: {}, sessions: {} });
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
});

describe("the sidebar's width", () => {
  const sep = () => screen.getByRole("separator", { name: "Sidebar width" });
  it("is a keyboard-reachable separator that arrow keys move within its limits and double-click resets", () => {
    const { container } = sidebar();
    const nav = container.querySelector<HTMLElement>(".sidebar")!;
    expect(sep().getAttribute("aria-valuenow")).toBe(String(SIDE_WIDTH));
    expect(sep().getAttribute("aria-valuemin")).toBe(String(SIDE_MIN));
    expect(sep().getAttribute("aria-valuemax")).toBe(String(SIDE_MAX));
    fireEvent.keyDown(sep(), { key: "ArrowRight" });
    expect(nav.style.getPropertyValue("--side-w")).toBe(`${SIDE_WIDTH + 16}px`);
    fireEvent.keyDown(sep(), { key: "End" });
    fireEvent.keyDown(sep(), { key: "ArrowRight" });
    expect(sep().getAttribute("aria-valuenow")).toBe(String(SIDE_MAX));
    fireEvent.keyDown(sep(), { key: "Home" });
    fireEvent.keyDown(sep(), { key: "ArrowLeft", shiftKey: true });
    expect(sep().getAttribute("aria-valuenow")).toBe(String(SIDE_MIN));
    expect(JSON.stringify(Object.fromEntries(Object.entries(localStorage)))).toContain(String(SIDE_MIN));
    fireEvent.doubleClick(sep());
    expect(sep().getAttribute("aria-valuenow")).toBe(String(SIDE_WIDTH));
  });
  it("clamps, and survives storage that throws", () => {
    expect(clampSide(10)).toBe(SIDE_MIN);
    expect(clampSide(9999)).toBe(SIDE_MAX);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => useSideWidth.getState().setWidth(300)).not.toThrow();
    expect(useSideWidth.getState().width).toBe(300);
    spy.mockRestore();
  });
});

describe("the sidebar's bottom block", () => {
  it("is folded by default to icon buttons with labels and shortcut tooltips, and a chevron opens it", () => {
    useSideFoot.setState({ open: false });
    sidebar();
    const bar = screen.getByRole("toolbar", { name: "Quick actions" });
    for (const name of ["New session", "New crew member", "Settings", "Turn voice on"]) expect(within(bar).getByRole("button", { name })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "New session" }).title).toContain("⌘N");
    expect(within(bar).getByRole("button", { name: "Settings" }).title).toContain("⌘,");
    expect(screen.queryByRole("radiogroup", { name: "Look" })).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("radiogroup", { name: "Look" })).toBeTruthy();
    expect(screen.queryByRole("toolbar", { name: "Quick actions" })).toBeNull();
    expect(localStorage.getItem("desk.sidebar.foot.main")).toBe("open");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(localStorage.getItem("desk.sidebar.foot.main")).toBeNull();
  });
});

describe("Sidebar", () => {
  it("lists the boards under Boards, as Rooms lists rooms: a + to make one, each opening its board", () => {
    useBoard.setState({ boards: { [ACME.id]: ACME, [GLOBEX.id]: GLOBEX }, supported: true, shown: null });
    sidebar();
    const boards = screen.getByRole("region", { name: "Boards" });
    // In the middle with Grids, Rooms and Groups, after Rooms; no row at the top.
    const regions = [...document.querySelectorAll(".side-scroll > [role=region]")].map((r) => r.getAttribute("aria-label"));
    expect(regions).toEqual(["Grids", "Rooms", "Boards", "Groups"]);
    expect(within(document.querySelector<HTMLElement>(".side-top")!).queryByRole("button", { name: /^Board/ })).toBeNull();
    // The same + as Rooms' and Groups'.
    const plus = within(boards).getByRole("button", { name: "New board" });
    expect(plus.className).toBe(within(screen.getByRole("region", { name: "Rooms" })).getByRole("button", { name: "New room" }).className);
    const rows = within(within(boards).getByRole("list", { name: "Boards" })).getAllByRole("button").filter((b) => b.classList.contains("gi"));
    expect(rows.map((b) => b.querySelector(".gi-name")!.textContent)).toEqual(["Acme", "Globex"]);
    fireEvent.click(rows[1]!);
    expect(useDesk.getState().view).toBe("board");
    expect(useBoard.getState().shown).toBe(GLOBEX.id);
    expect(rows[1]!.getAttribute("aria-current")).toBe("true");
    expect(rows[0]!.getAttribute("aria-current")).toBeNull();
    // Its ⋯ keeps what the board's own menu offers.
    fireEvent.click(within(boards).getByRole("button", { name: "Acme options" }));
    expect(screen.getByRole("menuitem", { name: "Rename board…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete board…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Link to Jira or Linear…" }));
    expect(screen.getByRole("heading", { name: "Link “Acme” to Jira or Linear" })).toBeTruthy();
  });

  it("makes a board from the +, and shows it", async () => {
    const made = { ...GLOBEX, id: "b-new", name: "Initech" };
    const createBoard = vi.fn(() => Promise.resolve(made));
    useDesk.setState({ hub: { createBoard } as never });
    useBoard.setState({ boards: {}, supported: true, shown: null });
    sidebar();
    fireEvent.click(screen.getByRole("button", { name: "New board" }));
    fireEvent.change(screen.getByPlaceholderText("Acme"), { target: { value: "Initech" } });
    fireEvent.click(screen.getByRole("button", { name: "Make board" }));
    await waitFor(() => expect(useDesk.getState().view).toBe("board"));
    expect(createBoard).toHaveBeenCalledWith({ name: "Initech" });
    expect(useBoard.getState().shown).toBe("b-new");
    expect(within(screen.getByRole("list", { name: "Boards" })).getByText("Initech")).toBeTruthy();
  });

  it("has no Boards on a hub that keeps none", () => {
    useBoard.setState({ boards: {}, supported: false });
    sidebar();
    expect(screen.queryByRole("region", { name: "Boards" })).toBeNull();
  });

  it("opens and closes Rooms, Boards and Groups from their headers, remembered, and a closed one still says what's for you", () => {
    useBoard.setState({
      boards: { [ACME.id]: ACME },
      tickets: { t1: ticket(1, { state: "review" }), t2: ticket(2, { state: "review" }), t3: ticket(3) },
      supported: true,
    });
    sidebar();
    for (const name of ["Rooms", "Boards", "Groups"]) {
      const region = screen.getByRole("region", { name });
      const head = within(region).getByRole("button", { name: new RegExp(`^${name}`) });
      expect(head.getAttribute("aria-expanded")).toBe("true");
      expect(document.getElementById(head.getAttribute("aria-controls")!)).toBeTruthy();
      expect(head.querySelector(".grp-chevron.open")).toBeTruthy();
    }
    const boards = screen.getByRole("region", { name: "Boards" });
    const head = within(boards).getByRole("button", { name: /^Boards/ });
    // Open, the count is on the board's row, not the header.
    expect(head.querySelector(".badge")).toBeNull();
    expect(within(screen.getByRole("list", { name: "Boards" })).getByText("2 need you")).toBeTruthy();
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(head.getAttribute("aria-controls")).toBeNull();
    expect(screen.queryByRole("list", { name: "Boards" })).toBeNull();
    // Closed: the header says it.
    expect(head.querySelector(".badge")!.textContent).toBe("22 need you");
    expect(head.textContent).toMatch(/Boards.*2 need you/);
    expect(JSON.parse(localStorage.getItem(SECTIONS_KEY)!)).toEqual({ boards: true });
    fireEvent.click(within(screen.getByRole("region", { name: "Rooms" })).getByRole("button", { name: /^Rooms/ }));
    expect(JSON.parse(localStorage.getItem(SECTIONS_KEY)!)).toEqual({ boards: true, rooms: true });
    // Still closed after a restart.
    cleanup();
    reloadSections();
    sidebar();
    expect(within(screen.getByRole("region", { name: "Boards" })).getByRole("button", { name: /^Boards/ }).getAttribute("aria-expanded")).toBe("false");
    expect(within(screen.getByRole("region", { name: "Groups" })).getByRole("button", { name: /^Groups/ }).getAttribute("aria-expanded")).toBe("true");
    // The + opens it, so what's made shows.
    fireEvent.click(within(screen.getByRole("region", { name: "Boards" })).getByRole("button", { name: "New board" }));
    expect(within(screen.getByRole("region", { name: "Boards" })).getByRole("button", { name: /^Boards/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("says on a closed Rooms what its rooms' rows said, together", () => {
    const room = (id: string, name: string) => ({ id, slug: id, name, members: [], defaultMember: null, createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-01T09:00:00Z" }) as unknown as Room;
    const failed = (id: string) => ({ id, member: "local/allan", threadId: null, asked: "m1", since: 0, text: "", working: null, tools: [], attachments: [], prompts: [], state: "failed" as const });
    useDesk.setState({ rooms: { r1: room("r1", "Launch"), r2: room("r2", "Ops") }, roomDrafts: { r1: [failed("d1")], r2: [failed("d2"), failed("d3")] } });
    sidebar();
    const rooms = screen.getByRole("region", { name: "Rooms" });
    expect(within(rooms).getByText("1 needs you")).toBeTruthy();
    expect(within(rooms).getByText("2 need you")).toBeTruthy();
    const head = within(rooms).getByRole("button", { name: /^Rooms/ });
    expect(head.querySelector(".badge")).toBeNull();
    fireEvent.click(head);
    expect(head.querySelector(".badge")!.textContent).toContain("3 need you");
    useDesk.setState({ roomDrafts: {} });
  });

  it("opens a closed Rooms or Boards when its row becomes the one shown, once, and says the board's shortcut", () => {
    const room = { id: "r1", slug: "r1", name: "Launch", members: [], defaultMember: null, createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-01T09:00:00Z" } as unknown as Room;
    useDesk.setState({ rooms: { r1: room }, activeRoom: null });
    useBoard.setState({ boards: { [ACME.id]: ACME }, supported: true, shown: null });
    sidebar();
    const head = (name: string) => within(screen.getByRole("region", { name })).getByRole("button", { name: new RegExp(`^${name}`) });
    expect(head("Boards").title).toMatch(/^Boards \(.*B\)$/);
    fireEvent.click(head("Rooms"));
    fireEvent.click(head("Boards"));
    act(() => useDesk.setState({ activeRoom: "r1", view: "rooms" }));
    expect(head("Rooms").getAttribute("aria-expanded")).toBe("true");
    expect(head("Boards").getAttribute("aria-expanded")).toBe("false");
    // Closed again by hand while it's still shown, it stays closed.
    fireEvent.click(head("Rooms"));
    act(() => useDesk.setState({ view: "floor" }));
    expect(head("Rooms").getAttribute("aria-expanded")).toBe("false");
    act(() => useDesk.setState({ view: "board" }));
    expect(head("Boards").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(head("Boards"));
    act(() => useBoard.setState({ boards: { [ACME.id]: ACME } }));
    expect(head("Boards").getAttribute("aria-expanded")).toBe("false");
    useDesk.setState({ activeRoom: null });
  });

  it("keeps working when this browser's storage can't be read or written", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    reloadSections();
    sidebar();
    const head = within(screen.getByRole("region", { name: "Groups" })).getByRole("button", { name: /^Groups/ });
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    get.mockRestore();
    set.mockRestore();
  });

  it("shows each shortcut's configured keys", () => {
    sidebar();
    expect(screen.getByRole("button", { name: /Ask anyone/ }).textContent).toBe("Ask anyone ⌃⇧K");
    expect(screen.getByRole("button", { name: "New session" }).textContent).toBe("New session ⌘N");
    expect(screen.getByRole("button", { name: /^Settings/ }).textContent).toBe("Settings ⌘,");
    cleanup();
    useSettings.getState().set({ shortcuts: { ask: "Alt+Space", newSession: "Super+Y", settings: "Control+Alt+Comma" } });
    sidebar();
    expect(screen.getByRole("button", { name: /Ask anyone/ }).textContent).toBe("Ask anyone ⌥Space");
    expect(screen.getByRole("button", { name: "New session" }).textContent).toBe("New session ⌘Y");
    expect(screen.getByRole("button", { name: /^Settings/ }).textContent).toBe("Settings ⌃⌥,");
  });

  it("keeps Ask anyone and the Dashboard at the top, the actions, voice and look at the bottom, and scrolls the rest", () => {
    const { container } = sidebar();
    const top = container.querySelector(".side-top")!;
    const middle = container.querySelector(".side-scroll")!;
    const foot = container.querySelector(".side-foot")!;
    expect(within(top as HTMLElement).getByRole("button", { name: /Ask anyone/ })).toBeTruthy();
    expect(within(top as HTMLElement).getByRole("button", { name: /^Dashboard/ })).toBeTruthy();
    // No tabs: one sidebar, whatever the main area shows.
    expect(container.querySelector("[role=tablist]")).toBeNull();
    expect(within(middle as HTMLElement).getByRole("region", { name: "Grids" })).toBeTruthy();
    expect(within(middle as HTMLElement).getByRole("region", { name: "Rooms" })).toBeTruthy();
    expect(within(middle as HTMLElement).getByRole("region", { name: "Groups" })).toBeTruthy();
    const actions = within(foot as HTMLElement).getAllByRole("button").filter((b) => b.classList.contains("side-btn"));
    expect(actions.map((b) => b.querySelector(".side-btn-label")!.textContent)).toEqual(["New session", "New crew member", "Settings"]);
    // One button style for all three, Settings included.
    expect(actions.every((b) => b.className === "btn side-btn")).toBe(true);
    expect(within(foot as HTMLElement).getByRole("radiogroup", { name: "Look" })).toBeTruthy();
    // Nothing that's meant to stay put is inside what scrolls.
    for (const el of [top, foot]) expect(middle.contains(el)).toBe(false);
    expect([...container.querySelector(".sidebar")!.children].map((c) => c.className)).toEqual(["side-resize", "side-top", "side-mid", "side-foot"]);
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

describe("the Dashboard in the sidebar", () => {
  const dash = () => screen.getByRole("button", { name: /^Dashboard/ });
  afterEach(() => useFloor.setState({ hubs: {} }));

  it("opens the Dashboard, lit while it shows, and counts what needs you in amber", () => {
    useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "", local: true, revision: "" }] });
    useFloor.setState({ hubs: { local: ready(floorView({ needs: [need("q-1", agent("scout")), need("q-2", asker("s9"))] })) } });
    useDesk.setState({ view: "rooms", inbox: false });
    useUi.setState({ settings: "appearance" });
    sidebar();
    expect(dash().getAttribute("aria-current")).toBeNull();
    const badge = dash().querySelector(".badge")!;
    expect(badge.classList.contains("badge-needs")).toBe(true);
    expect(within(dash()).getByText("2 need you")).toBeTruthy();
    fireEvent.click(dash());
    expect(useDesk.getState().view).toBe("floor");
    expect(useUi.getState().settings).toBeNull();
    expect(dash().getAttribute("aria-current")).toBe("page");
    expect(dash().classList.contains("on")).toBe(true);
  });

  it("has no badge while nothing needs you", () => {
    sidebar();
    expect(dash().querySelector(".badge")).toBeNull();
  });
});

describe("grid rows", () => {
  const gridRow = (name: string) => within(screen.getByRole("list", { name: "Grids" })).getAllByRole("button").find((b) => b.querySelector(".gi-name")?.textContent === name)!;
  const s = (id: string, state: Session["state"]): Session =>
    ({ id, engine: "claude", name: id, goal: "", cwd: "/tmp", state, live: true, createdAt: "", updatedAt: "" }) as Session;
  const show = (gridId: string, sessions: string[]) =>
    act(() => {
      const g = useGrids.getState().grids[gridId]!;
      const panes = sessions.map((id, i) => ({ id: `p-${gridId}-${i}`, content: { kind: "session" as const, sessionId: id }, rect: { x: i, y: 0, w: 1, h: 1 } }));
      useGrids.setState((st) => ({ grids: { ...st.grids, [gridId]: { ...g, panes } } }));
    });

  it("say what their panes are doing, with a dot to match: needs you, working, or quiet", () => {
    let two = "";
    let three = "";
    act(() => {
      two = createGrid();
      three = createGrid();
    });
    useDesk.setState({ sessions: { a: s("a", "blocked"), b: s("b", "working"), c: s("c", "working"), d: s("d", "working") } });
    show(MAIN_GRID, ["a", "b"]);
    show(two, ["b", "c", "d"]);
    show(three, []);
    sidebar();
    const meta = (name: string) => gridRow(name).querySelector(".gi-meta")!;
    const dot = (name: string) => gridRow(name).querySelector(".dot")!.className;
    expect(meta("Main").textContent).toBe("1 needs you");
    expect(meta("Main").classList.contains("state-blocked")).toBe(true);
    expect(dot("Main")).toContain("dot-blocked");
    expect(meta("Grid 2").textContent).toBe("3 working");
    expect(dot("Grid 2")).toContain("dot-working");
    expect(meta("Grid 3").textContent).toBe("quiet");
    expect(dot("Grid 3")).toContain("dot-idle");
    // As it changes, its row says so.
    act(() => useDesk.setState((d) => ({ sessions: { ...d.sessions, a: s("a", "working") } })));
    expect(meta("Main").textContent).toBe("2 working");
  });

  it("lights the shown grid only while a grid shows, as a room's row is lit only in Rooms", () => {
    useDesk.setState({ view: "floor" });
    sidebar();
    expect(gridRow("Main").getAttribute("aria-current")).toBeNull();
    // Picked from the Dashboard, it shows, and its row is lit.
    fireEvent.click(gridRow("Main"));
    expect(useDesk.getState().view).toBe("grids");
    expect(gridRow("Main").getAttribute("aria-current")).toBe("true");
    act(() => useDesk.setState({ view: "rooms" }));
    expect(gridRow("Main").getAttribute("aria-current")).toBeNull();
  });

  it("shows a new grid from its +, from wherever you were", () => {
    useDesk.setState({ view: "floor" });
    sidebar();
    fireEvent.click(screen.getByRole("button", { name: "New grid" }));
    expect(useDesk.getState().view).toBe("grids");
    expect(gridRow("Grid 2").getAttribute("aria-current")).toBe("true");
  });

  it("says where a grid in its own window is, and when it's away", () => {
    act(() => {
      const g = useGrids.getState().grids[MAIN_GRID]!;
      useGrids.setState({ grids: { [MAIN_GRID]: { ...g, placement: { kind: "window", mode: "fill", monitor: { id: "m", name: "Studio Display", origin: { x: 0, y: 0 } } as never } } }, open: { [MAIN_GRID]: true } });
    });
    sidebar();
    expect(gridRow("Main").querySelector(".gi-meta")!.textContent).toBe("quiet");
    expect(gridRow("Main").title).toMatch(/^In Studio Display\. /);
    act(() => useGrids.setState({ open: {} }));
    expect(gridRow("Main").querySelector(".gi-meta")!.textContent).toBe("quiet · away");
  });

  it("shows a grid from the Dashboard: an away one brought back, one in its own window brought forward", async () => {
    const windows = await import("../grids/windows");
    const forward = vi.spyOn(windows, "focusGridWindow").mockResolvedValue();
    const place = (open: boolean) =>
      act(() => {
        const g = useGrids.getState().grids[MAIN_GRID]!;
        useGrids.setState({ grids: { [MAIN_GRID]: { ...g, placement: { kind: "window", mode: "fill", monitor: { id: "m", name: "Studio Display", origin: { x: 0, y: 0 } } as never } } }, open: open ? { [MAIN_GRID]: true } : {} });
      });
    place(true);
    useDesk.setState({ view: "rooms" });
    sidebar();
    fireEvent.click(gridRow("Main"));
    expect(forward).toHaveBeenCalledWith(MAIN_GRID);
    expect(useDesk.getState().view).toBe("rooms");
    // Away: shown here, from wherever you were.
    place(false);
    act(() => useDesk.setState({ view: "floor" }));
    fireEvent.click(gridRow("Main"));
    expect(useGrids.getState().grids[MAIN_GRID]!.placement.kind).toBe("main");
    expect(useDesk.getState().view).toBe("grids");
    // Moved back from its menu, from the Dashboard, it shows.
    place(false);
    act(() => useDesk.setState({ view: "floor" }));
    fireEvent.click(screen.getByRole("button", { name: "Main options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move back to the main window" }));
    expect(useDesk.getState().view).toBe("grids");
    forward.mockRestore();
  });

  it("says nothing of no grids until it knows", () => {
    useGrids.setState({ ready: false, order: [], grids: {} });
    sidebar();
    expect(within(screen.getByRole("region", { name: "Grids" })).queryByText("No grids yet")).toBeNull();
    act(() => useGrids.setState({ ready: true }));
    expect(within(screen.getByRole("region", { name: "Grids" })).getByText("No grids yet")).toBeTruthy();
  });

  it("folds, remembered, and folded still says what waits on you in its grids, each thing once", () => {
    useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "", local: true, revision: "" }] });
    let two = "";
    act(() => void (two = createGrid()));
    useDesk.setState({ sessions: { a: s("a", "blocked"), b: s("b", "asking"), c: s("c", "working") } });
    show(MAIN_GRID, ["a", "c"]);
    show(two, ["b"]);
    // a waits on you twice over (blocked, and a need on the Floor): once.
    useFloor.setState({ hubs: { local: ready(floorView({ needs: [need("q-1", asker("a"))] })) } });
    sidebar();
    const toggle = within(screen.getByRole("region", { name: "Grids" })).getByRole("button", { name: /^Grids/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(gridRow("Main").querySelector(".gi-meta")!.textContent).toBe("1 needs you");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Grids" })).toBeNull();
    expect(within(toggle).getByText("2 need you")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(SECTIONS_KEY)!)).toEqual({ grids: true });
    cleanup();
    reloadSections();
    sidebar();
    expect(screen.queryByRole("list", { name: "Grids" })).toBeNull();
    useFloor.setState({ hubs: {} });
  });

  it("opens a folded Grids when a grid is shown from elsewhere", async () => {
    const { revealIn } = await import("../grids/windows");
    useDesk.setState({ sessions: { a: s("a", "working") } });
    show(MAIN_GRID, ["a"]);
    useDesk.setState({ view: "floor" });
    sidebar();
    fireEvent.click(within(screen.getByRole("region", { name: "Grids" })).getByRole("button", { name: /^Grids/ }));
    expect(screen.queryByRole("list", { name: "Grids" })).toBeNull();
    act(() => void revealIn(MAIN_GRID, { kind: "session", sessionId: "a" }));
    expect(useDesk.getState().view).toBe("grids");
    expect(gridRow("Main").getAttribute("aria-current")).toBe("true");
  });

  it("stays folded when Desk starts on a grid, as it was left", () => {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify({ grids: true }));
    reloadSections();
    useDesk.setState({ view: "grids" });
    sidebar();
    act(() => useGrids.setState({ active: MAIN_GRID }));
    expect(screen.queryByRole("list", { name: "Grids" })).toBeNull();
  });

  it("counts a session once however many panes show it, a machine's in its terminal too", () => {
    const remote = (state: Session["state"]) =>
      ({ ...s("t1", state), machine: "mac2", terminalId: "term1" }) as Session;
    act(() => {
      const g = useGrids.getState().grids[MAIN_GRID]!;
      const panes = [
        { id: "p1", content: { kind: "session" as const, sessionId: "mac2/t1" }, rect: { x: 0, y: 0, w: 1, h: 1 } },
        { id: "p2", content: { kind: "terminal" as const, terminalId: "term1", machine: "mac2" }, rect: { x: 1, y: 0, w: 1, h: 1 } },
      ];
      useGrids.setState((st) => ({ grids: { ...st.grids, [MAIN_GRID]: { ...g, panes } } }));
    });
    useDesk.setState({ sessions: { "mac2/t1": remote("working") } });
    sidebar();
    expect(gridRow("Main").querySelector(".gi-meta")!.textContent).toBe("1 working");
    act(() => useDesk.setState({ sessions: { "mac2/t1": remote("blocked") } }));
    expect(gridRow("Main").querySelector(".gi-meta")!.textContent).toBe("1 needs you");
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
  it("deletes a room from its ⋯ menu once you confirm, telling its members' hubs first", async () => {
    const closed: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: URL | string, init?: RequestInit) => {
        closed.push(`${new URL(u).pathname} ${String(init?.body)}`);
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }),
    );
    useChat.setState({ hubs: [{ id: "dw", label: "Driftwerk", url: "https://dw.example.com", local: false, revision: "t" }] });
    const deleteRoom = vi.fn(() => {
      expect(closed).toEqual(['/api/desk/conversations/allan/close {"channel":"desk:r1-channel","undelivered":[]}']);
      return Promise.resolve();
    });
    const room = { id: "r1", name: "Launch", slug: "launch", channel: "desk:r1-channel", members: [{ hub: "dw", agent: "allan" }] } as unknown as Room;
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
    vi.unstubAllGlobals();
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
    expect(within(grids).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Grids", "New grid"]);
    expect(within(grids).getByText("No grids yet")).toBeTruthy();
    // + makes one again.
    fireEvent.click(within(grids).getByRole("button", { name: "New grid" }));
    expect(useGrids.getState().order).toHaveLength(1);
    expect(within(grids).queryByText("No grids yet")).toBeNull();
  });

  it("shows agents with their pictures, and you round at the bottom, opening your Profile", async () => {
    servePictures();
    const local = { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" };
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

describe("unread in the sidebar", () => {
  it("badges agent, session, group, room and grid rows from one count", async () => {
    const { useUnread } = await import("../unread/summary");
    useChat.setState({
      hubs: [{ id: "local", label: "This computer", url: "", local: true, revision: "" }],
      roster: [{ hubId: "local", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
    });
    useSettings.setState({ loaded: true, groups: [{ id: "acme", name: "Acme", collapsed: false, items: ["agent:local/allan", "session:s1"] }], ungrouped: { collapsed: false, items: [] } });
    useDesk.setState({
      view: "rooms",
      rooms: { r1: { id: "r1", slug: "atlas-launch", name: "Atlas launch", members: [], defaultMember: null, createdAt: "", updatedAt: "" } },
      sessions: { s1: { id: "s1", engine: "claude", name: "acme-web", goal: "", cwd: "/tmp", state: "stopped", live: false, createdAt: "", updatedAt: "" } as never },
    });
    useRoomOrder.setState({ order: ["r1"] });
    const unread = (count: number, forYou: number) => ({ count, forYou, first: null, lastAt: null });
    useUnread.setState({
      dms: { "local/allan": { count: 3, for_you: 2, first: null, last: null, capped: false } },
      local: {
        floor: "",
        rooms: [{ roomId: "r1", main: unread(4, 1), threads: [] }],
        sessions: [{ id: "s1", since: "", urgency: "new" }],
        activity: { count: 0, lastAt: null },
        brief: null,
        update: null,
      },
    });
    sidebar();
    const rowOf = (name: string) => screen.getAllByRole("button").find((b) => b.classList.contains("gi") && b.querySelector(".gi-name")?.textContent === name)!;
    expect(within(rowOf("Allan")).getByText("2 need you")).toBeTruthy();
    expect(rowOf("acme-web").querySelector(".side-dot")).not.toBeNull();
    expect(within(rowOf("Atlas launch")).getByText("1 needs you")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Acme" })).getByText("2 need you", { selector: ".grp-toggle .badge > *" })).toBeTruthy();
    cleanup();
    act(() => useDesk.setState({ view: "grids" }));
    act(() => {
      const g = useGrids.getState().grids[MAIN_GRID]!;
      useGrids.setState({ grids: { [MAIN_GRID]: { ...g, panes: [{ ...g.panes[0]!, content: { kind: "agent", agent: "local/allan" } }, ...g.panes.slice(1)] } } });
    });
    sidebar();
    // What's new in a grid's panes that isn't a need is its dot; the row's
    // words say what waits on you.
    expect(rowOf("Main").querySelector(".side-dot")).not.toBeNull();
    expect(rowOf("Main").querySelector(".gi-meta")!.textContent).toBe("quiet");
  });

  it("opens the Unread page from its row, which counts everything once", async () => {
    const { useUnread } = await import("../unread/summary");
    useUnread.setState({ dms: { "local/allan": { count: 1, for_you: 1, first: null, last: null, capped: false } }, local: null });
    useDesk.setState({ view: "floor", inbox: false });
    sidebar();
    const row = screen.getByRole("button", { name: /^Unread/ });
    expect(within(row).getByText("1 needs you")).toBeTruthy();
    fireEvent.click(row);
    expect(useDesk.getState()).toMatchObject({ view: "rooms", inbox: true });
  });
});
