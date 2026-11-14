import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import type { Session, TerminalInfo } from "../hub/types";
import type { PaneContent } from "../grids/engine";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { createGrid, deliver, layOut, renameGrid, setActive, startGrids, useGrids } from "../grids/store";
import { useTerminals } from "../grids/terminals";
import { SessionCard } from "./SessionCard";
import { bandOf } from "./SessionChrome";
import { useCharges } from "../crew/chargeStore";
import { useOverview } from "../overview/store";

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
/** The card's ⋯ menu, opened: what it offers. */
const options = () => {
  fireEvent.click(screen.getByRole("button", { name: "Session options" }));
  return within(screen.getByRole("menu", { name: "api-e7 options" }))
    .getAllByRole("menuitem")
    .map((m) => m.textContent);
};
const lines = () => within(where()!).getAllByRole("listitem").map((li) => li.firstChild?.textContent);

describe("a session's card says where the session already is", () => {
  it("in a grid: goes to its pane, focused and pointed out, and closes", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, own);
    deliver(MAIN_GRID, { kind: "session", sessionId: "s2" });
    card();
    expect(lines()).toEqual(["In grid Main"]);
    expect(options().some((t) => t?.startsWith("Put in grid"))).toBe(false);
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
    expect(options().some((t) => t?.startsWith("Put in grid"))).toBe(true);
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
    // Until the hub says it has that terminal, there's none to show.
    const { unmount } = card();
    expect(where()).toBeNull();
    expect(options().some((t) => t?.startsWith("Put in grid"))).toBe(true);
    unmount();
    useTerminals.setState({ byId: { t1: { id: "t1", live: true } as TerminalInfo } });
    card();
    expect(lines()).toEqual(["Running in a Desk terminal that isn’t in a grid"]);
    act(() => fireEvent.click(screen.getByRole("button", { name: "Show it" })));
    expect(useGrids.getState().grids[MAIN_GRID]!.panes.some((p) => p.content?.kind === "terminal" && p.content.terminalId === "t1")).toBe(true);
    expect(useDesk.getState().openId).toBeNull();
  });
});

describe("a session Desk started that isn't running", () => {
  it("never says it runs in another terminal, and offers Resume", () => {
    // A machine's Claude Code that never drew, stopped: its last state is "starting".
    useDesk.setState({ sessions: { s1: session({ machine: "devbox", live: false, state: "starting", cliSessionId: "c1" }) } });
    card();
    expect(screen.queryByText(/Running in another terminal/)).toBeNull();
    expect(screen.getByText("Not running. Resume picks up the same conversation.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Stop tracking/ })).toBeNull();
  });

  it("one from another terminal still says so", () => {
    useDesk.setState({ sessions: { s1: session({ origin: "external", live: false, state: "working", cliSessionId: "c1" }) } });
    card();
    expect(screen.getByText(/Running in another terminal/)).toBeTruthy();
  });
});

describe("a session's card says when Desk set a non-asking mode", () => {
  it("says so in its line for auto and for bypass, and nothing otherwise", () => {
    const { unmount } = card();
    expect(screen.queryByText(/set by Desk\)/)).toBeNull();
    unmount();
    for (const [mode, text] of [["auto", "Auto mode (set by Desk)"], ["bypassPermissions", "Bypass mode (set by Desk)"]] as const) {
      useDesk.setState({ sessions: { s1: session({ mode }) } });
      const r = card();
      expect(screen.getByText(new RegExp(text.replace(/[()]/g, "\\$&"))).textContent).toContain(text);
      r.unmount();
    }
  });
});

describe("a session's card says the model it was given", () => {
  it("names it after the engine, by its listed title or its exact id, and nothing for the engine's default", () => {
    const { unmount } = card();
    expect(screen.queryByText(/Claude Code · Opus/)).toBeNull();
    unmount();
    for (const [model, text] of [["opus", "Claude Code · Opus"], ["claude-opus-5-5[1m]", "Claude Code · claude-opus-5-5[1m]"]] as const) {
      useDesk.setState({ sessions: { s1: session({ model }) } });
      const r = card();
      expect(screen.getByText((_, el) => el?.tagName !== "HEADER" && !!el?.textContent?.startsWith(text) && el.children.length === 0)).toBeTruthy();
      r.unmount();
    }
  });
});

describe("a session's chrome", () => {
  const hub = { interrupt: vi.fn(() => Promise.resolve()), stop: vi.fn(() => Promise.resolve()), resume: vi.fn(() => Promise.resolve()), update: vi.fn(() => Promise.resolve()), history: vi.fn(() => Promise.resolve({ events: [], more: false })) };
  beforeEach(() => {
    for (const f of Object.values(hub)) f.mockClear();
    useDesk.setState({ hub: hub as never });
  });

  it("has one state button: Interrupt while it works, Resume once it runs nowhere; Stop is only in its menu", () => {
    const { unmount } = card();
    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(hub.interrupt).toHaveBeenCalledWith("s1");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(options().slice(-3)).toEqual(["Stop", "End session…", "Remove…"]);
    unmount();
    useDesk.setState({ sessions: { s1: session({ live: false, state: "stopped", cliSessionId: "c1" }) } });
    card();
    expect(screen.queryByRole("button", { name: "Interrupt" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(hub.resume).toHaveBeenCalledWith("s1");
  });

  it("shows Session, Memory or History, keeping the session mounted behind the others", () => {
    card();
    const tab = (name: string) => screen.getByRole("tab", { name });
    expect(tab("Session").getAttribute("aria-selected")).toBe("true");
    const view = document.getElementById(tab("Session").getAttribute("aria-controls")!)!;
    fireEvent.click(tab("History"));
    expect(tab("History").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("region", { name: "What api-e7 did" })).toBeTruthy();
    expect(view.hidden).toBe(true);
    expect(document.body.contains(view)).toBe(true);
    fireEvent.click(tab("Session"));
    expect(view.hidden).toBe(false);
  });

  it("edits its goal from its menu", () => {
    card();
    expect(options()).toContain("Add a goal…");
    fireEvent.click(screen.getByRole("menuitem", { name: "Add a goal…" }));
    const goal = screen.getByRole("textbox", { name: "Goal" });
    fireEvent.change(goal, { target: { value: "Ship the insights redirect" } });
    fireEvent.keyDown(goal, { key: "Enter" });
    expect(hub.update).toHaveBeenCalledWith("s1", { goal: "Ship the insights redirect" });
  });

  it("says what it is and where it runs in its first row", () => {
    useDesk.setState({ sessions: { s1: session({ cwd: "/tmp/patchworkhealth" }) } });
    card();
    const head = screen.getByRole("complementary", { name: "Session api-e7" }).querySelector("header")!;
    expect(head.textContent).toContain("working");
    expect(head.textContent).toContain("Claude Code");
    expect(head.textContent).toContain("/tmp/patchworkhealth");
  });
});

describe("who runs a session, in its chrome", () => {
  const charge = (wheel: "boss" | "person") => ({
    session: "s1",
    group: null,
    boss: "a1",
    bossName: "Desk",
    how: "started" as const,
    wheel,
    wheelSince: null,
    since: "2026-11-12T10:00:00Z",
    releasedAt: null,
  });
  afterEach(() => {
    useCharges.setState({ bySession: {} });
    useOverview.setState({ suggestions: {} });
  });

  it("is a chip that opens what that means and the choices, with no bar of its own", () => {
    useCharges.setState({ bySession: { s1: charge("boss") } });
    card();
    fireEvent.click(screen.getByRole("button", { name: "Who runs it: Desk has it" }));
    const who = screen.getByRole("dialog", { name: "Who runs api-e7" });
    expect(who.textContent).toContain("Desk runs this session.");
    expect(within(who).getAllByRole("button").map((b) => b.textContent)).toEqual(["I’ll drive", "Release"]);
    expect(screen.queryByRole("list", { name: /suggests/ })).toBeNull();
  });

  it("counts what the boss suggests while you drive, each in a bar to do or dismiss", () => {
    useCharges.setState({ bySession: { s1: charge("person") } });
    useOverview.setState({
      wantSuggestions: () => {},
      suggestions: { x1: { id: "x1", state: "open", subject: { kind: "session", id: "s1" }, text: "Run the eval spec again." } },
    } as never);
    card();
    expect(screen.getByRole("button", { name: "Who runs it: You’re driving, 1 suggested" })).toBeTruthy();
    const bar = screen.getByRole("list", { name: "What Desk suggests" });
    expect(bar.textContent).toContain("Run the eval spec again.");
    expect(within(bar).getByRole("button", { name: "Do it" })).toBeTruthy();
  });
});

describe("the chrome by width, and from the keyboard", () => {
  it("folds by its own width, the same in the side panel and a pane", () => {
    expect([700, 660, 600, 570, 500, 460, 400, 340, 300].map(bandOf)).toEqual(["wide", "wide", "medium", "medium", "compact", "compact", "narrow", "narrow", "tiny"]);
  });

  it("moves between its tabs with the arrows, one stop in the tab order", () => {
    card();
    const tab = (name: string) => screen.getByRole("tab", { name });
    expect([tab("Session"), tab("Memory"), tab("History")].map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(tab("Session"), { key: "ArrowLeft" });
    expect(tab("History").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("History"));
    fireEvent.keyDown(tab("History"), { key: "Home" });
    expect(tab("Session").getAttribute("aria-selected")).toBe("true");
  });

  it("opens its menu with Shift+F10 or the menu key, and from a right click on its header", () => {
    card();
    const head = screen.getByRole("complementary", { name: "Session api-e7" }).querySelector("header")!;
    fireEvent.keyDown(head, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu", { name: "api-e7 options" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(head.querySelector(".sc-name")!);
    expect(screen.getByRole("menu", { name: "api-e7 options" })).toBeTruthy();
  });
});
