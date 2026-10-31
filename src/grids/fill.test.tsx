import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { SessionCard } from "../session/SessionCard";
import { useSettings } from "../settings/store";
import { choose, defaultShortcuts, resolve, SHORTCUTS } from "../shortcuts/keys";
import type { PaneContent } from "./engine";
import { GridCanvas, useFillKeys } from "./GridView";
import { gridKey, MAIN_GRID } from "./model";
import type { GridStorage } from "./storage";
import { createGrid, deliver, filledPane, layOut, startGrids, toggleFill, unfill, useGrids } from "./store";
import { useTerminals } from "./terminals";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

const session = (id: string, name: string): Session => ({
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
});

/** Storage that counts what's written to it. */
const memory = () => {
  const kept = new Map<string, unknown>();
  const set = vi.fn((k: string, v: unknown) => void kept.set(k, structuredClone(v)));
  return { kept, set, store: { get: (k: string) => kept.get(k), set, remove: (k: string) => void kept.delete(k), subscribe: () => () => {} } as GridStorage };
};

const sess = (id: string): PaneContent => ({ kind: "session", sessionId: id });
let storage: ReturnType<typeof memory>;

beforeEach(() => {
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null, filled: {} });
  storage = memory();
  startGrids(storage.store, { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  const sessions: Record<string, Session> = {};
  for (let i = 0; i < 4; i++) sessions[`s${i}`] = session(`s${i}`, `task-${i}`);
  useDesk.setState({ sessions, hub: { closeTerminal: vi.fn() } as never, openId: null, view: "floor" });
  useTerminals.setState({ byId: {}, known: true, programs: {}, problems: {} });
  useSettings.setState({ keys: defaultShortcuts() });
});
afterEach(cleanup);

/** Main as four panes, s0…s3. */
const four = () => {
  layOut(MAIN_GRID, "quarters");
  for (let i = 0; i < 4; i++) deliver(MAIN_GRID, sess(`s${i}`));
};
const pane = (name: string) => screen.getByRole("region", { name });

function Grid({ keys = true }: { keys?: boolean }) {
  const g = useGrids((s) => s.grids[MAIN_GRID]!);
  useFillKeys(MAIN_GRID, keys);
  return <GridCanvas grid={g} />;
}

describe("filling the grid", () => {
  it("gives one pane the whole grid for a while, the others mounted but hidden, without touching the saved layout", () => {
    four();
    const saved = storage.kept.get(gridKey(MAIN_GRID));
    const panes = useGrids.getState().grids[MAIN_GRID]!.panes;
    render(<Grid />);
    storage.set.mockClear();
    const fill = within(pane("task-1")).getByRole("button", { name: "Fill the grid" });
    expect(fill.title).toBe("Fill the grid (⇧⌘↩)");
    fireEvent.click(fill);
    expect(filledPane(useGrids.getState(), MAIN_GRID)).toBe(useGrids.getState().grids[MAIN_GRID]!.panes.find((p) => p.content?.kind === "session" && p.content.sessionId === "s1")!.id);
    expect(pane("task-1").style).toMatchObject({ left: "0px", top: "0px", width: "100%", height: "100%" });
    // The others are still there, out of sight.
    for (const name of ["task-0", "task-2", "task-3"]) expect(document.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!.style.display).toBe("none");
    expect(within(pane("task-1")).getByText("3 other panes waiting")).toBeTruthy();
    expect(screen.queryByRole("separator")).toBeNull();

    fireEvent.click(within(pane("task-1")).getByRole("button", { name: "Back to the grid" }));
    expect(filledPane(useGrids.getState(), MAIN_GRID)).toBeNull();
    expect(screen.getAllByRole("separator").length).toBeGreaterThan(0);
    // Nothing about the layout was written or changed (clicking a pane only
    // says when it was last used, as any click does).
    const after = useGrids.getState().grids[MAIN_GRID]!.panes;
    expect(after.map((p) => [p.id, p.rect, p.content])).toEqual(panes.map((p) => [p.id, p.rect, p.content]));
    for (const [, value] of storage.set.mock.calls) {
      expect((value as { panes: typeof panes }).panes.map((p) => [p.id, p.rect, p.content])).toEqual(panes.map((p) => [p.id, p.rect, p.content]));
    }
    expect((storage.kept.get(gridKey(MAIN_GRID)) as { panes: typeof panes }).panes.filter((p) => !p.rect)).toEqual(
      (saved as { panes: typeof panes }).panes.filter((p) => !p.rect),
    );
  });

  it("isn't a store write at all", () => {
    four();
    const before = useGrids.getState().grids[MAIN_GRID];
    storage.set.mockClear();
    const id = before!.panes.find((p) => p.rect)!.id;
    toggleFill(MAIN_GRID, id);
    expect(filledPane(useGrids.getState(), MAIN_GRID)).toBe(id);
    toggleFill(MAIN_GRID, id);
    expect(filledPane(useGrids.getState(), MAIN_GRID)).toBeNull();
    toggleFill(MAIN_GRID, id);
    unfill(MAIN_GRID);
    expect(useGrids.getState().grids[MAIN_GRID]).toBe(before);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("toggles for the focused pane on ⌘⇧↩, and goes back on Esc unless a terminal had it", () => {
    four();
    render(<Grid />);
    fireEvent.pointerDown(pane("task-2"));
    fireEvent.keyDown(window, { code: "Enter", key: "Enter", metaKey: true, shiftKey: true });
    const s2 = useGrids.getState().focus[MAIN_GRID];
    expect(filledPane(useGrids.getState(), MAIN_GRID)).toBe(s2);
    const frame = document.createElement("div");
    frame.className = "terminal-frame";
    const input = document.createElement("textarea");
    frame.append(input);
    document.body.append(frame);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(filledPane(useGrids.getState(), MAIN_GRID)).toBe(s2);
    frame.remove();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(filledPane(useGrids.getState(), MAIN_GRID)).toBeNull();
    fireEvent.keyDown(window, { code: "Enter", key: "Enter", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { code: "Enter", key: "Enter", metaKey: true, shiftKey: true });
    expect(filledPane(useGrids.getState(), MAIN_GRID)).toBeNull();
  });

  it("takes keys only while the grid is in sight", () => {
    four();
    render(<Grid keys={false} />);
    fireEvent.pointerDown(pane("task-2"));
    fireEvent.keyDown(window, { code: "Enter", key: "Enter", metaKey: true, shiftKey: true });
    expect(filledPane(useGrids.getState(), MAIN_GRID)).toBeNull();
  });

  it("has its shortcut in Settings → Shortcuts, which can be changed", () => {
    expect(SHORTCUTS.find((s) => s.id === "fillPane")).toMatchObject({ name: "Fill the grid", keys: "Shift+Primary+Enter", scope: "app" });
    const chosen = choose({}, "fillPane", "Control+Super+F12");
    expect(resolve(chosen).keys.fillPane).toBe("Primary+Control+F12");
    useSettings.setState({ keys: resolve(chosen).keys });
    four();
    render(<Grid />);
    fireEvent.pointerDown(pane("task-0"));
    fireEvent.keyDown(window, { code: "Enter", key: "Enter", metaKey: true, shiftKey: true });
    expect(filledPane(useGrids.getState(), MAIN_GRID)).toBeNull();
    fireEvent.keyDown(window, { code: "F12", key: "F12", metaKey: true, ctrlKey: true });
    expect(filledPane(useGrids.getState(), MAIN_GRID)).toBe(useGrids.getState().focus[MAIN_GRID]);
  });
});

describe("Put in grid", () => {
  it("lists the grids and New grid, and puts the session there, shown in the grid", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, sess("s0"));
    useDesk.setState({ openId: "s1" });
    render(<SessionCard session={useDesk.getState().sessions.s1!} />);
    fireEvent.click(screen.getByRole("button", { name: "Put this session in a grid" }));
    const menu = screen.getByRole("menu", { name: "Put in grid" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Main", "New grid"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Main" }));
    const panes = useGrids.getState().grids[MAIN_GRID]!.panes;
    expect(panes.filter((p) => p.rect).map((p) => p.content)).toEqual([sess("s0"), sess("s1")]);
    expect(useDesk.getState()).toMatchObject({ view: "grids", openId: null });
    expect(useGrids.getState().flash?.paneIds).toEqual([panes.find((p) => p.content?.kind === "session" && p.content.sessionId === "s1")!.id]);
  });

  it("makes a new grid for it", () => {
    useDesk.setState({ openId: "s2" });
    render(<SessionCard session={useDesk.getState().sessions.s2!} />);
    fireEvent.click(screen.getByRole("button", { name: "Put this session in a grid" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New grid" }));
    const s = useGrids.getState();
    expect(s.order).toHaveLength(2);
    const made = s.grids[s.order[1]!]!;
    expect(made.panes.map((p) => p.content)).toContainEqual(sess("s2"));
    expect(s.active).toBe(made.id);
    expect(useDesk.getState().openId).toBeNull();
  });

  it("brings a filled grid back so what was put in it shows", () => {
    four();
    toggleFill(MAIN_GRID, useGrids.getState().grids[MAIN_GRID]!.panes.find((p) => p.rect)!.id);
    const other = createGrid();
    useGrids.setState({ active: MAIN_GRID });
    void other;
    useDesk.setState({ sessions: { ...useDesk.getState().sessions, s9: session("s9", "task-9") }, openId: "s9" });
    render(<SessionCard session={useDesk.getState().sessions.s9!} />);
    fireEvent.click(screen.getByRole("button", { name: "Put this session in a grid" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Main" }));
    expect(filledPane(useGrids.getState(), MAIN_GRID)).toBeNull();
  });
});
