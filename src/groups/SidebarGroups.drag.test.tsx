import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { useSettings } from "../settings/store";
import { setSectionOpen } from "../shell/SideSection";
import { EMPTY_LAYOUT } from "./model";
import { clearSelection, useSelection } from "./selection";
import { contentOfItem, useGridDrag } from "../grids/drag";
import { createGrid, startGrids, useGrids } from "../grids/store";
import type { GridStorage } from "../grids/storage";
import { MAIN_GRID } from "../grids/model";
import { SidebarGroups } from "./SidebarGroups";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

type Source = { id: string; type: string };
type Ended = (e: { canceled: boolean; operation: { source: Source; target: Source & { element: null }; position: { current: { x: number; y: number } } } }) => void;

// dnd-kit's drags need a real pointer: the provider's handlers are taken
// here and called as a drop would.
const dnd = vi.hoisted(() => ({ ended: null as Ended | null, overlay: null as ((source: Source) => ReactNode) | null }));
vi.mock("@dnd-kit/react", () => ({
  DragDropProvider: ({ children, onDragEnd }: { children: ReactNode; onDragEnd?: Ended }) => {
    if (onDragEnd) dnd.ended = onDragEnd;
    return children;
  },
  DragOverlay: ({ children }: { children: (source: Source) => ReactNode }) => {
    dnd.overlay = children;
    return null;
  },
  useDraggable: () => ({ isDragSource: false }),
  useDroppable: () => ({}),
}));

const session = (id: string, name: string): Session =>
  ({ id, engine: "claude", name, goal: "", cwd: "/tmp", origin: "desk", state: "idle", live: false, createdAt: "", updatedAt: "" }) as Session;

const rows = (group: string) =>
  within(screen.getByRole("group", { name: group }))
    .queryAllByRole("button")
    .filter((b) => b.dataset.item)
    .map((b) => b.querySelector(".gi-name")!.textContent);
const row = (name: string) => screen.getAllByRole("button").find((b) => b.dataset.item && b.querySelector(".gi-name")?.textContent === name)!;
const end = (id: string, on: Source) =>
  dnd.ended!({ canceled: false, operation: { source: { id, type: "item" }, target: { ...on, element: null }, position: { current: { x: 0, y: 0 } } } });
const drop = (id: string, on: Source) => act(async () => end(id, on));

beforeEach(() => {
  setSectionOpen("groups", true);
  useChat.setState({ hubs: [], roster: [] });
  useDesk.setState({ sessions: { s1: session("s1", "api"), s2: session("s2", "web"), s3: session("s3", "docs") }, openId: null });
  useSettings.setState({
    loaded: true,
    groups: [
      { id: "acme", name: "Acme", collapsed: false, items: ["session:s1", "session:s2", "session:s3"] },
      { id: "beta", name: "Beta", collapsed: false, items: [] },
    ],
    ungrouped: EMPTY_LAYOUT.ungrouped,
    sessionNames: {},
  });
});
afterEach(() => {
  clearSelection();
  cleanup();
});

describe("dragging picked rows", () => {
  it("moves the whole selection where one of them is dropped, one row at a time, and the chip says how many", async () => {
    render(<SidebarGroups />);
    fireEvent.click(row("api"), { metaKey: true });
    fireEvent.click(row("docs"), { metaKey: true });
    const chip = render(<>{dnd.overlay!({ id: "session:s1", type: "item" })}</>);
    expect(chip.container.querySelector(".drag-chip")?.textContent).toBe("2 selected");
    await drop("session:s1", { id: "group:beta", type: "group" });
    expect(rows("Beta")).toEqual(["api", "docs"]);
    expect(rows("Acme")).toEqual(["web"]);
    expect(screen.getByText("Moved 2 items to Beta")).toBeTruthy();
  });

  it("lands them before the first row from there on that isn't picked", async () => {
    render(<SidebarGroups />);
    fireEvent.click(row("web"), { metaKey: true });
    fireEvent.click(row("docs"), { metaKey: true });
    await drop("session:s3", { id: "session:s1", type: "item" });
    expect(rows("Acme")).toEqual(["web", "docs", "api"]);
  });

  describe("dropping on a grid", () => {
    const freshGrid = () => {
      const kept = new Map<string, unknown>();
      const memory = { get: (k: string) => kept.get(k), set: (k: string, v: unknown) => void kept.set(k, structuredClone(v)), remove: (k: string) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
      useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
      startGrids(memory, { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
      return createGrid();
    };
    const dropOn = (grid: string, key: string, name: string) => {
      act(() => useGridDrag.setState({ item: { content: contentOfItem(key)!, name }, over: { kind: "row", gridId: grid } }));
      act(() => end(key, { id: key, type: "item" }));
    };
    /** Where each of `keys` shows in the grid, in pane order (-1: not there). */
    const placed = (grid: string, keys: string[]) => {
      const shown = useGrids.getState().grids[grid]!.panes.map((p) => JSON.stringify(p.content));
      return keys.map((k) => shown.indexOf(JSON.stringify(contentOfItem(k))));
    };

    it("puts the whole selection there in sidebar order, and says how many went", () => {
      const grid = freshGrid();
      render(<SidebarGroups />);
      fireEvent.click(row("api"), { metaKey: true });
      fireEvent.click(row("docs"), { metaKey: true });
      dropOn(grid, "session:s3", "docs");
      const [api, web, docs] = placed(grid, ["session:s1", "session:s2", "session:s3"]);
      expect(web).toBe(-1);
      expect(api).toBeGreaterThanOrEqual(0);
      expect(docs).toBeGreaterThan(api!);
      expect(screen.getByText(/^Added 2 items to /)).toBeTruthy();
    });

    it("puts only the row dragged there when it isn't one of those picked", () => {
      const grid = freshGrid();
      render(<SidebarGroups />);
      fireEvent.click(row("api"), { metaKey: true });
      fireEvent.click(row("docs"), { metaKey: true });
      dropOn(grid, "session:s2", "web");
      expect(placed(grid, ["session:s1", "session:s2", "session:s3"]).map((i) => i >= 0)).toEqual([false, true, false]);
    });
  });

  it("takes the click that ends a drag for neither a pick nor an open", async () => {
    render(<SidebarGroups />);
    fireEvent.click(row("api"), { metaKey: true });
    fireEvent.click(row("web"), { metaKey: true });
    act(() => end("session:s1", { id: "group:beta", type: "group" }));
    fireEvent.click(row("docs"));
    await act(async () => {});
    expect([...useSelection.getState().keys].sort()).toEqual(["session:s1", "session:s2"]);
    expect(useDesk.getState().openId).toBeNull();
  });
});
