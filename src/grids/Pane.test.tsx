import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { useSettings } from "../settings/store";
import type { PaneContent } from "./engine";
import { useChat } from "../chat/store";
import { useUi } from "../shell/ui";
import { GridCanvas, LayoutUndo } from "./GridView";
import { MAIN_GRID } from "./model";
import type { GridStorage } from "./storage";
import { dropPane } from "./drag";
import { createGrid, deliver, layOut, startGrids, useGrids } from "./store";
import { useTerminals } from "./terminals";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("../session/Terminal", () => ({ Terminal: () => null }));

const session = (id: string, name: string, more: Partial<Session> = {}): Session => ({
  id,
  engine: "claude",
  name,
  goal: "",
  cwd: "/tmp",
  branch: null,
  origin: "desk",
  state: "idle",
  live: false,
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
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, v), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

const sess = (id: string): PaneContent => ({ kind: "session", sessionId: id });
const closeTerminal = vi.fn(() => Promise.resolve());

beforeEach(() => {
  closeTerminal.mockClear();
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  const sessions: Record<string, Session> = {};
  for (let i = 0; i < 4; i++) sessions[`s${i}`] = session(`s${i}`, `task-${i}`);
  useDesk.setState({ sessions, hub: { closeTerminal } as never, openId: null });
  useTerminals.setState({ byId: {}, known: true, programs: {}, problems: {} });
});
afterEach(cleanup);

const grid = () => useGrids.getState().grids[MAIN_GRID]!;
const canvas = () => render(<Grid />);
function Grid() {
  const g = useGrids((s) => s.grids[MAIN_GRID]!);
  return (
    <>
      <LayoutUndo gridId={MAIN_GRID} />
      <GridCanvas grid={g} />
    </>
  );
}

describe("a pane's header", () => {
  it("has a remove button that takes a session off the grid without ending it", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, sess("s0"));
    deliver(MAIN_GRID, sess("s1"));
    canvas();
    const pane = screen.getByRole("region", { name: "task-0" });
    const remove = within(pane).getByRole("button", { name: "Remove from grid" });
    expect(remove.getAttribute("title")).toBe("Remove from grid");
    fireEvent.click(remove);
    expect(grid().panes.some((p) => p.content?.kind === "session" && p.content.sessionId === "s0")).toBe(false);
    expect(useDesk.getState().sessions.s0).toBeTruthy();
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  it("asks before closing a terminal with something still running", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "terminal", terminalId: "t1" });
    useTerminals.setState({ programs: { t1: ["zsh", "vim"] } });
    canvas();
    const pane = screen.getAllByRole("region").find((r) => r.dataset.dropPane && within(r).queryByText(/vim/))!;
    fireEvent.click(within(pane).getByRole("button", { name: "Remove from grid" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("vim is still running in it.")).toBeTruthy();
    expect(closeTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    expect(closeTerminal).toHaveBeenCalledWith("t1");
  });
});

describe("a session's pane", () => {
  const stop = vi.fn(() => Promise.resolve());
  const resume = vi.fn(() => Promise.resolve());
  const shown = (more: Partial<Session>) => {
    useDesk.setState((s) => ({ hub: { closeTerminal, stop, resume } as never, sessions: { ...s.sessions, s0: { ...s.sessions.s0!, ...more } } }));
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, sess("s0"));
    canvas();
    return screen.getByRole("region", { name: "task-0" });
  };
  const fromMenu = (pane: HTMLElement, label: string) => {
    fireEvent.click(within(pane).getByRole("button", { name: "Pane options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: label }));
  };
  beforeEach(() => {
    stop.mockClear();
    resume.mockClear();
  });

  it("resumes one Desk started that has stopped, from its header or its options", () => {
    const pane = shown({ state: "interrupted" });
    fireEvent.click(within(pane).getByRole("button", { name: "Resume" }));
    fromMenu(pane, "Resume");
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledWith("s0");
    expect(within(pane).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("stops one that is running, from its header or its options", () => {
    const pane = shown({ live: true, state: "working" });
    fireEvent.click(within(pane).getByRole("button", { name: "Stop" }));
    fromMenu(pane, "Stop");
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledWith("s0");
    expect(within(pane).queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("offers neither for one running in another terminal", () => {
    const pane = shown({ origin: "external" });
    expect(within(pane).queryByRole("button", { name: "Resume" })).toBeNull();
    fireEvent.click(within(pane).getByRole("button", { name: "Pane options" }));
    expect(screen.queryByRole("menuitem", { name: "Resume" })).toBeNull();
  });
});

describe("a smaller layout", () => {
  it("lists what it parked in a tray, says so with an undo, and swaps one back in on a click", () => {
    layOut(MAIN_GRID, "quarters");
    for (let i = 0; i < 4; i++) deliver(MAIN_GRID, sess(`s${i}`));
    useDesk.setState((s) => ({ sessions: { ...s.sessions, s2: { ...s.sessions.s2!, pending: { kind: "tool", tool: "Bash" } as never } } }));
    canvas();
    act(() => layOut(MAIN_GRID, "one"));
    // s2 needs you, so it stays; the other three park.
    expect(screen.getByRole("status").textContent).toBe("3 items parked · Undo");
    const tray = screen.getByRole("region", { name: "Parked (3)" });
    expect(within(tray).getAllByRole("button", { name: /^task-/ }).map((b) => b.textContent).sort()).toEqual(["task-0", "task-1", "task-3"]);
    expect(within(tray).getByRole("button", { name: "Remove task-0 from grid" })).toBeTruthy();
    act(() => fireEvent.click(within(tray).getByRole("button", { name: "task-0" })));
    expect(grid().panes.find((p) => p.rect)!.content).toEqual(sess("s0"));
    // The grid changed since, so it can't be undone any more.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is put back exactly by its undo", () => {
    layOut(MAIN_GRID, "quarters");
    for (let i = 0; i < 4; i++) deliver(MAIN_GRID, sess(`s${i}`));
    const before = structuredClone(grid().panes);
    canvas();
    act(() => layOut(MAIN_GRID, "halves"));
    act(() => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    expect(grid().panes).toEqual(before);
    expect(screen.queryByRole("region", { name: /Parked/ })).toBeNull();
  });
});

describe("dropping a dragged pane", () => {
  it("moves it within its grid by its own id, and to another grid's next free place from its sidebar row", () => {
    layOut(MAIN_GRID, "thirds");
    deliver(MAIN_GRID, { kind: "terminal", terminalId: "t1" });
    deliver(MAIN_GRID, sess("s1"));
    deliver(MAIN_GRID, sess("s2"));
    const [t, , c] = grid().panes;
    dropPane({ gridId: MAIN_GRID, paneId: t!.id }, { kind: "pane", gridId: MAIN_GRID, paneId: c!.id, zone: "top" });
    const moved = grid().panes.find((p) => p.id === t!.id)!;
    expect(moved.content).toEqual({ kind: "terminal", terminalId: "t1" });
    expect(moved.rect).toEqual({ x: 8, y: 0, w: 4, h: 6 });
    // Its own row: nothing to do.
    dropPane({ gridId: MAIN_GRID, paneId: t!.id }, { kind: "row", gridId: MAIN_GRID });
    expect(grid().panes.find((p) => p.id === t!.id)!.rect).toEqual({ x: 8, y: 0, w: 4, h: 6 });
    const other = createGrid();
    dropPane({ gridId: MAIN_GRID, paneId: t!.id }, { kind: "row", gridId: other });
    expect(grid().panes.some((p) => p.content?.kind === "terminal")).toBe(false);
    expect(useGrids.getState().grids[other]!.panes[0]!.content).toEqual({ kind: "terminal", terminalId: "t1" });
    expect(closeTerminal).not.toHaveBeenCalled();
  });
});

describe("dragging a parked pane from the tray", () => {
  it("swaps it in whatever part of a pane it's dropped on, parking that pane", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, sess("s0"));
    deliver(MAIN_GRID, sess("s1"));
    deliver(MAIN_GRID, sess("s2"));
    layOut(MAIN_GRID, "halves");
    const parked = grid().panes.find((p) => !p.rect)!;
    const target = grid().panes.find((p) => p.rect)!;
    dropPane({ gridId: MAIN_GRID, paneId: parked.id, parked: true }, { kind: "pane", gridId: MAIN_GRID, paneId: target.id, zone: "left" });
    expect(grid().panes.find((p) => p.id === parked.id)!.rect).toEqual(target.rect);
    expect(grid().panes.find((p) => p.id === target.id)!.rect).toBeNull();
    expect(grid().panes.filter((p) => p.rect)).toHaveLength(2);
  });
});

describe("a session renamed in Desk", () => {
  afterEach(() => useSettings.setState({ sessionNames: {} }));

  it("goes by its new name in the replace menu, the move-to-grid menu and its header", () => {
    useSettings.setState({ sessionNames: { s0: "date picker", s3: "invoice totals" } });
    createGrid();
    useGrids.setState({ active: MAIN_GRID });
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, sess("s0"));
    deliver(MAIN_GRID, sess("s1"));
    deliver(MAIN_GRID, sess("s3"));
    canvas();
    act(() => layOut(MAIN_GRID, "halves"));
    // The header.
    const pane = screen.getByRole("region", { name: "date picker" });
    expect(within(pane).getByText("date picker")).toBeTruthy();
    // Its options, and Replace's list of sessions.
    fireEvent.click(within(pane).getByRole("button", { name: "Pane options" }));
    expect(screen.getByRole("menu", { name: "date picker options" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Replace" }));
    const replace = screen.getByRole("menu", { name: "Replace" });
    const labels = within(replace).getAllByRole("menuitem").map((m) => m.firstChild?.textContent);
    expect(labels).toContain("date picker");
    expect(labels).toContain("invoice totals");
    expect(labels).not.toContain("task-0");
    expect(labels).not.toContain("task-3");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    // Move to grid: the menu is the session's, by its new name.
    fireEvent.click(within(pane).getByRole("button", { name: "Pane options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to grid" }));
    expect(screen.getByRole("menu", { name: "Move to grid" })).toBeTruthy();
    expect(screen.getByRole("menu", { name: "date picker options" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  });

  it("is listed by its new name in the parked tray", () => {
    useSettings.setState({ sessionNames: { s2: "date picker" } });
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, sess("s1"));
    deliver(MAIN_GRID, sess("s2"));
    canvas();
    const s1 = grid().panes.find((p) => p.content && (p.content as { sessionId: string }).sessionId === "s1")!;
    act(() => {
      useGrids.setState((s) => ({ focus: { ...s.focus, [MAIN_GRID]: s1.id } }));
      layOut(MAIN_GRID, "one");
    });
    const tray = screen.getByRole("region", { name: "Parked (1)" });
    expect(within(tray).getByRole("button", { name: "date picker" })).toBeTruthy();
    expect(within(tray).getByRole("button", { name: "Remove date picker from grid" })).toBeTruthy();
  });
});

describe("an agent's pane", () => {
  it("opens the agent's Settings from its options", () => {
    vi.stubGlobal("WebSocket", class { readyState = 0; send() {} close() {} });
    useChat.setState({
      roster: [{ hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false }],
      hubs: [{ id: "local", label: "This Mac", url: "http://127.0.0.1:1", local: true, token: "t" }],
      activeAgent: null,
    });
    deliver(MAIN_GRID, { kind: "agent", agent: "local/scout" });
    canvas();
    const pane = screen.getByRole("region", { name: "Scout" });
    fireEvent.click(within(pane).getByRole("button", { name: "Pane options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Agent settings" }));
    expect(useChat.getState().activeAgent).toBe("local/scout");
    expect(useUi.getState().agentTabs["local/scout"]).toBe("settings");
  });
});
