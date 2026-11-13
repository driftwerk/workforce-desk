import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBoard } from "../board/store";
import { useBoardOrder } from "../board/order";
import { ACME, ticket } from "../board/testing";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { createGrid, startGrids, useGrids } from "../grids/store";
import { useDesk } from "../hub/store";
import type { Room } from "../hub/types";
import { useRoomOrder } from "../rooms/order";
import { useSettings } from "../settings/store";
import { defaultShortcuts } from "../shortcuts/keys";
import { DEFAULT_HOST, useHost } from "./host";
import { jumps } from "./JumpKey";
import { useSidebarJumps } from "./jump";
import { reloadSections, SECTIONS_KEY, setSectionOpen } from "./SideSection";
import { Sidebar } from "./Sidebar";
import { useUi } from "./ui";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

const none = () => {};
const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};
const room = (id: string, name: string): Room => ({ id, slug: id, name, members: [], defaultMember: null, createdAt: "", updatedAt: "" }) as Room;
const press = (digit: number, mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = { metaKey: true }, at: Element | Window = window) =>
  act(() => void fireEvent.keyDown(at, { code: `Digit${digit}`, key: String(digit), ...mods }));

beforeEach(() => {
  localStorage.removeItem(SECTIONS_KEY);
  reloadSections();
  useHost.setState({ ...DEFAULT_HOST, platform: "macos" });
  useSettings.setState({ shortcuts: {}, keys: defaultShortcuts("macos"), groups: [], sessionNames: {} });
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  createGrid();
  useGrids.setState({ active: MAIN_GRID });
  useRoomOrder.setState({ order: ["r1", "r2"] });
  useBoardOrder.setState({ order: [] });
  useBoard.setState({ boards: { [ACME.id]: ACME }, tickets: { t1: ticket(1) }, supported: true, shown: null, open: null });
  useDesk.setState({ view: "rooms", inbox: false, activeRoom: null, sessions: {}, rooms: { r1: room("r1", "Desk"), r2: room("r2", "Mantis") }, openRoom: vi.fn(async (id: string) => useDesk.setState({ activeRoom: id, view: "rooms" })) as never });
  useUi.setState({ settings: null });
});
afterEach(() => {
  cleanup();
  useHost.setState(DEFAULT_HOST);
});

// As App has it: the keys taken beside the sidebar, which Settings replaces.
function Harness() {
  useSidebarJumps();
  const settings = useUi((u) => u.settings);
  return settings ? <p>Settings</p> : <Sidebar onAsk={none} onNewSession={none} onNewRoom={none} onNewCrew={none} onSettings={none} />;
}
const sidebar = () => render(<Harness />);

describe("the sidebar's order for the Go to keys", () => {
  it("is the Dashboard, then the grids, rooms and boards of the open sections, nine at most", () => {
    const lists = { grids: ["g1", "g2"], rooms: ["r1"], boards: ["b1"] };
    expect(jumps(lists, {})).toEqual([
      { kind: "dashboard" },
      { kind: "grid", id: "g1" },
      { kind: "grid", id: "g2" },
      { kind: "room", id: "r1" },
      { kind: "board", id: "b1" },
    ]);
    // A folded section's rows aren't counted: the numbers are of the rows you see.
    expect(jumps(lists, { grids: true }).map((j) => ("id" in j ? j.id : j.kind))).toEqual(["dashboard", "r1", "b1"]);
    expect(jumps({ grids: Array.from({ length: 12 }, (_, i) => `g${i}`), rooms: [], boards: [] }, {})).toHaveLength(9);
  });
});

describe("⌘1 to ⌘9", () => {
  it("open the sidebar's items in order, from wherever you are, Settings too", () => {
    useUi.setState({ settings: "appearance" });
    sidebar();
    expect(screen.queryByRole("navigation")).toBeNull();
    press(1);
    expect(useDesk.getState().view).toBe("floor");
    expect(useUi.getState().settings).toBeNull();
    // ⌘2 and ⌘3: the grids; ⌘4 and ⌘5 the rooms; ⌘6 the board.
    press(3);
    expect(useDesk.getState().view).toBe("grids");
    expect(useGrids.getState().active).not.toBe(MAIN_GRID);
    press(2);
    expect(useGrids.getState().active).toBe(MAIN_GRID);
    press(5);
    expect(useDesk.getState().openRoom).toHaveBeenCalledWith("r2");
    press(6);
    expect(useDesk.getState().view).toBe("board");
    expect(useBoard.getState().shown).toBe(ACME.id);
    // Past the last item, nothing happens.
    press(9);
    expect(useDesk.getState().view).toBe("board");
  });

  it("skip a folded section's rows, and work from a field and a terminal", () => {
    act(() => setSectionOpen("grids", false));
    sidebar();
    const field = document.body.appendChild(document.createElement("textarea"));
    press(2, { metaKey: true }, field);
    expect(useDesk.getState().openRoom).toHaveBeenCalledWith("r1");
    const term = document.body.appendChild(document.createElement("div"));
    term.setAttribute("data-terminal", "");
    press(1, { metaKey: true }, term);
    expect(useDesk.getState().view).toBe("floor");
    field.remove();
    term.remove();
  });

  it("leave other keys alone: a digit alone, or with other modifiers, or behind a dialog", () => {
    sidebar();
    press(1, {});
    press(1, { metaKey: true, shiftKey: true });
    expect(useDesk.getState().view).toBe("rooms");
    const dialog = document.body.appendChild(document.createElement("div"));
    dialog.setAttribute("aria-modal", "true");
    press(1);
    expect(useDesk.getState().view).toBe("rooms");
    dialog.remove();
    press(1);
    expect(useDesk.getState().view).toBe("floor");
  });

  it("skip boards on a hub without them, and a folded Rooms", () => {
    useBoard.setState({ supported: false });
    act(() => setSectionOpen("rooms", false));
    sidebar();
    // ⌘1 the Dashboard, ⌘2 and ⌘3 the grids; nothing after.
    press(4);
    expect(useDesk.getState().view).toBe("rooms");
    expect(useDesk.getState().openRoom).not.toHaveBeenCalled();
    press(3);
    expect(useDesk.getState().view).toBe("grids");
  });

  it("follow the keys set in Settings", () => {
    useSettings.setState({ keys: { ...defaultShortcuts("macos"), goTo: "Control+Alt+1" } });
    sidebar();
    press(1);
    expect(useDesk.getState().view).toBe("rooms");
    act(() => void fireEvent.keyDown(window, { code: "Digit1", key: "1", ctrlKey: true, altKey: true }));
    expect(useDesk.getState().view).toBe("floor");
  });

  it("are shown on the lit row: ⌘2 on the first grid, while it shows", () => {
    sidebar();
    press(2);
    const list = screen.getByRole("list", { name: "Grids" });
    const lit = within(list).getAllByRole("button").find((b) => b.getAttribute("aria-current") === "true")!;
    expect(lit.querySelector(".gi-kbd")?.textContent).toBe("⌘2");
    expect(document.querySelectorAll(".gi-kbd")).toHaveLength(1);
    // A room lit in Rooms shows its own.
    press(4);
    expect(document.querySelector(".gi-kbd")?.textContent).toBe("⌘4");
    expect(screen.getByRole("button", { name: /^Dashboard/ }).title).toBe("Dashboard (⌘1)");
    expect(screen.getByRole("button", { name: /^Dashboard/ }).getAttribute("aria-keyshortcuts")).toBe("Meta+1");
  });
});
