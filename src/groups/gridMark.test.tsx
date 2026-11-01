import { cleanup, render, renderHook, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { changeGrid, closePane, createGrid, deliver, layOut, renameGrid, setFocus, startGrids, useGrids } from "../grids/store";
import { useSettings } from "../settings/store";
import { EMPTY_LAYOUT, type DeskGroup } from "./model";
import { useGridNames } from "../grids/InGrid";
import { SidebarGroups } from "./SidebarGroups";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

const agent = (hubId: string, id: string, name: string): Agent => ({ hubId, id, name, model: null, provider: null, isDefault: false });

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

const ACME: DeskGroup = { id: "acme", name: "Acme", collapsed: false, items: ["agent:local/scout", "session:s1", "session:s2"] };

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, v), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

beforeEach(() => {
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "", local: true, token: "" }],
    roster: [agent("local", "scout", "Scout")],
  });
  useDesk.setState({ sessions: { s1: session("s1", "api-e7"), s2: session("s2", "web-release", { terminalId: "t2", live: true } as Partial<Session>) }, openId: null });
  useSettings.setState({ loaded: true, groups: [ACME], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
});
afterEach(cleanup);

const row = (name: string) => screen.getAllByRole("button").find((b) => b.dataset.item && b.querySelector(".gi-name")?.textContent === name)!;
const mark = (name: string) => row(name).querySelector<HTMLElement>(".gi-grid");
/** What a screen reader adds after the row's name: the hint, then the mark. */
const described = (name: string) =>
  row(name)
    .getAttribute("aria-describedby")!
    .split(" ")
    .map((id) => document.getElementById(id)!.textContent!.trim());
const rename = (id: string, name: string) => act(() => renameGrid(id, name));

describe("the in-a-grid mark on sidebar rows", () => {
  it("shows for a session, an agent and a session in its terminal, and goes when it's removed", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    deliver(MAIN_GRID, { kind: "agent", agent: "local/scout" });
    deliver(MAIN_GRID, { kind: "terminal", terminalId: "t2" });
    render(<SidebarGroups />);
    for (const n of ["api-e7", "Scout", "web-release"]) {
      expect(mark(n)?.title).toBe("In grid Main");
      expect(mark(n)?.getAttribute("aria-hidden")).toBe("true");
    }
    const pane = useGrids.getState().grids[MAIN_GRID]!.panes.find((p) => p.content?.kind === "session")!;
    act(() => closePane(MAIN_GRID, pane.id));
    expect(mark("api-e7")).toBeNull();
    expect(mark("Scout")).not.toBeNull();
  });

  it("counts a grid in a window of its own and a parked pane", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    const other = createGrid();
    deliver(other, { kind: "agent", agent: "local/scout" });
    act(() => changeGrid(other, (g) => ({ ...g, placement: { kind: "window", mode: "fill", monitor: null } })));
    deliver(MAIN_GRID, { kind: "session", sessionId: "s2" });
    // The focused pane stays when the layout shrinks, so s1 is parked.
    act(() => setFocus(MAIN_GRID, useGrids.getState().grids[MAIN_GRID]!.panes.find((p) => p.content?.kind === "session" && p.content.sessionId === "s2")!.id));
    act(() => layOut(MAIN_GRID, "one"));
    expect(useGrids.getState().grids[MAIN_GRID]!.panes.find((p) => p.content?.kind === "session" && p.content.sessionId === "s1")!.rect).toBeFalsy();
    render(<SidebarGroups />);
    expect(mark("Scout")).not.toBeNull();
    expect(mark("api-e7")).not.toBeNull();
  });

  it("says one grid, or several, in the tooltip and the row's description", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    const review = createGrid();
    deliver(review, { kind: "session", sessionId: "s1" });
    rename(review, "Review");
    render(<SidebarGroups />);
    expect(mark("api-e7")?.title).toBe("In grids Main and Review");
    expect(described("api-e7")).toEqual([expect.stringContaining("Alt+Up"), "In grids Main and Review"]);
    const docs = createGrid();
    deliver(docs, { kind: "session", sessionId: "s1" });
    rename(docs, "Docs");
    expect(mark("api-e7")?.title).toBe("In grids Main, Review and Docs");
    // Not in a grid: no mark, no extra description, and not a tab stop.
    expect(mark("web-release")).toBeNull();
    expect(described("web-release")).toHaveLength(1);
    expect(row("api-e7").querySelectorAll("[tabindex]")).toHaveLength(0);
  });

  it("is a grid once however many of its panes are in it", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    deliver(MAIN_GRID, { kind: "terminal", terminalId: "t1" });
    const { result } = renderHook(() => useGridNames("session:s1"));
    expect(result.current).toEqual(["Main"]);
  });

  it("leaves a row alone when an unrelated grid changes", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    const other = createGrid();
    deliver(other, { kind: "agent", agent: "local/scout" });
    let renders = 0;
    renderHook(() => (renders++, useGridNames("session:s1")));
    const before = renders;
    // Another grid's name, its panes, focus and a flash: none of them are s1's.
    rename(other, "Elsewhere");
    act(() => deliver(other, { kind: "agent", agent: "local/ada" }));
    act(() => useGrids.setState({ focus: { ...useGrids.getState().focus, [other]: "x" } }));
    act(() => flashNothing());
    expect(renders).toBe(before);
    // Its own grid's name does.
    rename(MAIN_GRID, "Release");
    expect(renders).toBeGreaterThan(before);
  });
});

const flashNothing = () => useGrids.setState({ flash: { gridId: "none", paneIds: [], n: 1 } as never });
