import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import type { PaneContent } from "../grids/engine";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { createGrid, deliver, layOut, renameGrid, setActive, startGrids, useGrids } from "../grids/store";
import { useTerminals } from "../grids/terminals";
import { SessionCard } from "./SessionCard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("./Terminal", () => ({ Terminal: () => null }));

const session = (more: Partial<Session> = {}): Session => ({
  id: "s1",
  engine: "claude",
  name: "api-e7",
  goal: "",
  cwd: "/tmp",
  branch: null,
  origin: "desk",
  state: "working",
  live: true,
  cliSessionId: null,
  lastPrompt: null,
  lastReply: null,
  currentTool: null,
  pending: null,
  approvals: "desk",
  createdAt: "2026-10-29T08:00:00Z",
  updatedAt: "2026-10-29T08:00:00Z",
  ...more,
});

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

const own: PaneContent = { kind: "session", sessionId: "s1" };
const term: PaneContent = { kind: "terminal", terminalId: "t1" };
const paneOf = (gridId: string, c: PaneContent) => useGrids.getState().grids[gridId]!.panes.find((p) => JSON.stringify(p.content) === JSON.stringify(c))!;

beforeEach(() => {
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  useDesk.setState({ view: "floor", sessions: { s1: session() }, openId: "s1" });
  useTerminals.setState({ byId: {}, known: true, programs: {}, problems: {} });
});
afterEach(cleanup);

const card = () => render(<SessionCard session={useDesk.getState().sessions.s1!} />);
const where = () => screen.queryByRole("list", { name: "Where it is" });
const lines = () => within(where()!).getAllByRole("listitem").map((li) => li.firstChild?.textContent);

describe("a session's card says where the session already is", () => {
  it("in a grid: goes to its pane, focused and pointed out, and closes", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, own);
    deliver(MAIN_GRID, { kind: "session", sessionId: "s2" });
    card();
    expect(lines()).toEqual(["In grid Main"]);
    expect(screen.queryByRole("button", { name: "Put this session in a grid" })).toBeNull();
    act(() => fireEvent.click(screen.getByRole("button", { name: "Go to it in Main" })));
    const pane = paneOf(MAIN_GRID, own).id;
    expect(useGrids.getState().focus[MAIN_GRID]).toBe(pane);
    expect(useGrids.getState().flash).toMatchObject({ gridId: MAIN_GRID, paneIds: [pane] });
    expect(useDesk.getState().view).toBe("grids");
    expect(useDesk.getState().openId).toBeNull();
  });

  it("tracked in a terminal pane: names the terminal's grid and goes there", () => {
    useDesk.setState({ sessions: { s1: session({ terminalId: "t1" }) } });
    const ops = createGrid();
    renameGrid(ops, "Ops");
    deliver(ops, term);
    setActive(MAIN_GRID);
    card();
    expect(lines()).toEqual(["Running in a terminal in Ops"]);
    act(() => fireEvent.click(screen.getByRole("button", { name: "Go to the terminal in Ops" })));
    expect(useGrids.getState().active).toBe(ops);
    expect(useGrids.getState().focus[ops]).toBe(paneOf(ops, term).id);
    expect(useDesk.getState().openId).toBeNull();
  });

  it("in neither: offers Put in grid", () => {
    card();
    expect(where()).toBeNull();
    expect(screen.getByRole("button", { name: "Put this session in a grid" })).toBeTruthy();
  });

  it("in two grids: lists both, and swaps a parked pane back in to go to it", () => {
    const ops = createGrid();
    renameGrid(ops, "Ops");
    deliver(ops, own);
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, own);
    deliver(MAIN_GRID, { kind: "session", sessionId: "s2" });
    // s2 has focus, so the smaller layout parks s1.
    layOut(MAIN_GRID, "one");
    card();
    expect(lines()).toEqual(["In grid Main", "In grid Ops"]);
    act(() => fireEvent.click(screen.getByRole("button", { name: "Go to it in Main" })));
    expect(paneOf(MAIN_GRID, own).rect).not.toBeNull();
    expect(useGrids.getState().focus[MAIN_GRID]).toBe(paneOf(MAIN_GRID, own).id);
  });

  it("running in a Desk terminal no grid shows: puts that terminal in the grid shown now", () => {
    useDesk.setState({ sessions: { s1: session({ terminalId: "t1" }) } });
    card();
    expect(lines()).toEqual(["Running in a Desk terminal that isn’t in a grid"]);
    act(() => fireEvent.click(screen.getByRole("button", { name: "Show it" })));
    expect(useGrids.getState().grids[MAIN_GRID]!.panes.some((p) => p.content?.kind === "terminal" && p.content.terminalId === "t1")).toBe(true);
    expect(useDesk.getState().openId).toBeNull();
  });
});
