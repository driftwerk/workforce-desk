import { invoke } from "@tauri-apps/api/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import { Tile } from "../floor/SessionTile";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { SessionCard } from "../session/SessionCard";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { closeContent } from "../grids/terminals";
import { createGrid, deleteGrid, deliver, layOut, setActive, setFocus, startGrids, toggleFill, useGrids } from "../grids/store";
import { useSettings } from "../settings/store";
import { EMPTY_LAYOUT, type DeskGroup } from "./model";
import { HOVER_MS, SidebarGroups } from "./SidebarGroups";
import { setSectionOpen, useSections } from "../shell/SideSection";
import { LifecycleDialogs } from "../session/LifecycleDialogs";
import { useMachines } from "../hub/engines";
import { useMachineSessions } from "./machines";
import { QUIET, toggleTalk, useMic } from "../voice/mic";
import { clearSelection, useSelection } from "./selection";
import { DEFAULT_HOST, useHost } from "../shell/host";
import type { Closing } from "../hub/types";
import { plainError } from "../ui/plainError";
import { useUnread } from "../unread/summary";
import { useReads } from "../unread/reads";
import { instant } from "../rooms/time";

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

const ACME: DeskGroup = { id: "acme", name: "Acme", collapsed: false, items: ["agent:local/scout", "session:s1"] };
const BETA: DeskGroup = { id: "beta", name: "Beta", collapsed: false, items: [] };

const saves = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "settings_save");
const lastSaved = () => (saves().at(-1)?.[1] as { settings: Record<string, unknown> }).settings;

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  setSectionOpen("groups", true);
  useChat.setState({
    hubs: [
      { id: "local", label: "This computer", url: "", local: true, revision: "" },
      { id: "remote", label: "Office", url: "", local: false, revision: "" },
    ],
    roster: [agent("local", "scout", "Scout"), agent("remote", "ada", "Ada")],
  });
  useDesk.setState({
    sessions: { s1: session("s1", "api-e7"), s2: session("s2", "web-release", { state: "blocked" }), gone: session("gone", "old", { state: "closed" }) },
    openId: null,
  });
  useSettings.setState({ loaded: true, groups: [ACME, BETA], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
});
afterEach(cleanup);

const groups = () => render(<SidebarGroups />);
const section = (name: string) => screen.getByRole("group", { name });
const rows = (name: string) =>
  within(section(name))
    .queryAllByRole("button")
    .filter((b) => b.dataset.item)
    .map((b) => b.querySelector(".gi-name")!.textContent);
const row = (name: string) => screen.getAllByRole("button").find((b) => b.dataset.item && b.querySelector(".gi-name")?.textContent === name)!;
const header = (name: string) => within(section(name)).getAllByRole("button")[0]!;

describe("groups in the sidebar", () => {
  it("shows each group with its agents and sessions, and the rest in Ungrouped", () => {
    groups();
    expect(rows("Acme")).toEqual(["Scout", "api-e7"]);
    expect(rows("Beta")).toEqual([]);
    expect(within(section("Beta")).getByText(/Empty/)).toBeTruthy();
    expect(rows("Ungrouped")).toEqual(["Ada", "web-release"]);
    expect(header("Acme").textContent).toContain("2");
    expect(row("web-release").textContent).toContain("needs you");
    expect(row("Ada").textContent).toContain("Office");
  });

  it("marks the agent you're talking with", () => {
    groups();
    const mic = (name: string) => within(row(name)).queryByRole("img", { name: "Has the microphone" });
    expect(mic("Scout")).toBeNull();
    act(() => toggleTalk("local/scout"));
    expect(mic("Scout")).toBeTruthy();
    expect(mic("Ada")).toBeNull();
    act(() => useMic.setState(QUIET));
    expect(mic("Scout")).toBeNull();
  });

  it("makes a new group, named in place", () => {
    groups();
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    const field = screen.getByRole("textbox", { name: "Group name" });
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "Gamma" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(section("Gamma")).toBeTruthy();
    expect((lastSaved().groups as DeskGroup[]).map((g) => g.name)).toEqual(["Acme", "Beta", "Gamma"]);
    expect(document.activeElement).toBe(header("Gamma"));
  });

  it("collapses a group, and remembers it", () => {
    groups();
    fireEvent.click(header("Acme"));
    expect(header("Acme").getAttribute("aria-expanded")).toBe("false");
    expect(rows("Acme")).toEqual([]);
    expect((lastSaved().groups as DeskGroup[])[0]!.collapsed).toBe(true);
  });

  it("renames a session by double-click or F2: Enter saves, Escape cancels", () => {
    groups();
    fireEvent.doubleClick(row("api-e7"));
    let field = screen.getByRole("textbox", { name: "Rename api-e7" });
    fireEvent.change(field, { target: { value: "date picker" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(rows("Acme")).toEqual(["Scout", "api-e7"]);
    expect(document.activeElement).toBe(row("api-e7"));

    fireEvent.keyDown(row("api-e7"), { key: "F2" });
    field = screen.getByRole("textbox", { name: "Rename api-e7" });
    fireEvent.change(field, { target: { value: "date picker" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(rows("Acme")).toEqual(["Scout", "date picker"]);
    expect(lastSaved().sessionNames).toEqual({ s1: "date picker" });
  });

  it("a renamed session shows its new name on the Floor and in its header", () => {
    useSettings.setState({ sessionNames: { s1: "date picker" } });
    render(<Tile session={useDesk.getState().sessions.s1!} />);
    expect(screen.getByText("date picker", { selector: ".tile-title" })).toBeTruthy();
    cleanup();
    render(<SessionCard session={useDesk.getState().sessions.s1!} />);
    expect(screen.getByRole("complementary", { name: "Session date picker" })).toBeTruthy();
    expect(screen.queryByText("api-e7")).toBeNull();
  });

  it("agents can't be renamed here, and aren't told they can", () => {
    groups();
    expect(document.getElementById(row("Scout").getAttribute("aria-describedby")!)!.textContent).not.toContain("F2");
    expect(document.getElementById(row("api-e7").getAttribute("aria-describedby")!)!.textContent).toContain("F2");
    fireEvent.keyDown(row("Scout"), { key: "F2" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("moves an item with Alt+↑/↓, over group edges, keeping focus and saying where", () => {
    groups();
    row("Scout").focus();
    fireEvent.keyDown(row("Scout"), { key: "ArrowDown", altKey: true });
    expect(rows("Acme")).toEqual(["api-e7", "Scout"]);
    expect(document.activeElement).toBe(row("Scout"));
    expect(screen.getByText("Scout: Acme, 2 of 2")).toBeTruthy();
    fireEvent.keyDown(row("Scout"), { key: "ArrowDown", altKey: true });
    expect(rows("Acme")).toEqual(["api-e7"]);
    expect(rows("Beta")).toEqual(["Scout"]);
    expect(document.activeElement).toBe(row("Scout"));
    fireEvent.keyDown(row("Scout"), { key: "ArrowDown", altKey: true });
    expect(rows("Ungrouped")).toEqual(["Scout", "Ada", "web-release"]);
    fireEvent.keyDown(row("api-e7"), { key: "ArrowUp", altKey: true });
    expect(screen.getByText("Already at the top")).toBeTruthy();
    expect((lastSaved().ungrouped as { items: string[] }).items).toEqual(["agent:local/scout", "agent:remote/ada", "session:s2"]);
  });

  it("reorders groups with Alt+↑/↓ on their headers", () => {
    groups();
    fireEvent.keyDown(header("Beta"), { key: "ArrowUp", altKey: true });
    expect(screen.getAllByRole("group").map((r) => r.getAttribute("aria-label"))).toEqual(["Beta", "Acme", "Ungrouped"]);
    expect(document.activeElement).toBe(header("Beta"));
  });

  it("moves an item to a group from its menu, with the keyboard", () => {
    groups();
    fireEvent.keyDown(row("web-release"), { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "web-release options" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["RenameF2", "Move to group▸", "Add to grid▸", "Open", "Continue in…", "End session…", "Remove…⌫"]);
    expect(document.activeElement?.textContent).toBe("RenameF2");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    const sub = screen.getByRole("menu", { name: "Move to group" });
    expect(within(sub).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Acme", "Beta", "New group…"]);
    expect(document.activeElement?.textContent).toBe("Acme");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.queryByRole("menu", { name: "Move to group" })).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.click(document.activeElement!);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(rows("Beta")).toEqual(["web-release"]);
    expect(document.activeElement).toBe(row("web-release"));
  });

  it("removes from a group, opens, and moves to a new group from the right-click menu", () => {
    groups();
    fireEvent.contextMenu(row("api-e7"), { clientX: 40, clientY: 200 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from group" }));
    expect(rows("Ungrouped")).toEqual(["Ada", "web-release", "api-e7"]);

    fireEvent.contextMenu(row("api-e7"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(useDesk.getState().openId).toBe("s1");

    fireEvent.contextMenu(row("Ada"));
    expect(screen.queryByRole("menuitem", { name: /Rename/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /Move to group/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New group…" }));
    const field = screen.getByRole("textbox", { name: "Group name" });
    fireEvent.change(field, { target: { value: "Remote" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(rows("Remote")).toEqual(["Ada"]);
  });

  it("Escape closes a menu and puts focus back", () => {
    groups();
    fireEvent.keyDown(row("Scout"), { key: "ContextMenu" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(row("Scout"));
  });

  it("renames and deletes a group from its options; its members go to Ungrouped", () => {
    groups();
    fireEvent.click(screen.getByRole("button", { name: "Acme options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename group/ }));
    const field = screen.getByRole("textbox", { name: "Group name" });
    fireEvent.change(field, { target: { value: "Acme Labs" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(section("Acme Labs")).toBeTruthy();

    fireEvent.doubleClick(header("Acme Labs"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Group name" }), { key: "Escape" });
    expect(section("Acme Labs")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Acme Labs options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete group" }));
    expect(screen.queryByRole("group", { name: "Acme Labs" })).toBeNull();
    expect(rows("Ungrouped")).toEqual(["Ada", "web-release", "Scout", "api-e7"]);
    expect((lastSaved().groups as DeskGroup[]).map((g) => g.id)).toEqual(["beta"]);
  });

  it("opens a group's Boss sheet from its options", async () => {
    groups();
    fireEvent.click(screen.getByRole("button", { name: "Acme options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Boss…" }));
    expect(await screen.findByRole("dialog", { name: "Acme · Boss" })).toBeTruthy();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("boss_status", { group: "acme" });
  });

  it("Ungrouped has no handle or rename, and its options only select its rows or clear finished sessions", () => {
    groups();
    fireEvent.click(screen.getByRole("button", { name: "Ungrouped options" }));
    const menu = screen.getByRole("menu", { name: "Ungrouped options" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Select all in Ungrouped", "Clear finished sessions…"]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.keyDown(header("Ungrouped"), { key: "F2" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("asks before removing a session, from its menu or with Delete", () => {
    render(
      <>
        <SidebarGroups />
        <LifecycleDialogs />
      </>,
    );
    // One from another terminal: only stopped being tracked.
    act(() => useDesk.setState((s) => ({ sessions: { ...s.sessions, s1: { ...s.sessions.s1!, origin: "external" } } })));
    fireEvent.contextMenu(row("api-e7"), { clientX: 40, clientY: 200 });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Stop tracking…/ }));
    expect(screen.getByRole("dialog", { name: "Stop tracking “api-e7”?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useDesk.setState((s) => ({ sessions: { ...s.sessions, s1: { ...s.sessions.s1!, state: "stopped" } } })));
    fireEvent.keyDown(row("api-e7"), { key: "Delete" });
    expect(screen.getByRole("dialog", { name: "Remove “api-e7”?" })).toBeTruthy();
  });

  it("a session the hub closes drops out; a new one lands in Ungrouped", () => {
    groups();
    act(() =>
      useDesk.setState((s) => ({ sessions: { ...s.sessions, s1: { ...s.sessions.s1!, state: "closed" }, s3: session("s3", "fresh") } })),
    );
    expect(rows("Acme")).toEqual(["Scout"]);
    expect(rows("Ungrouped")).toEqual(["Ada", "web-release", "fresh"]);
  });
});

describe("sessions and agents in grids", () => {
  const memory = (): GridStorage => {
    const kept = new Map<string, unknown>();
    return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, v), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
  };
  beforeEach(() => {
    useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
    startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
    useDesk.setState({ view: "floor", openId: null });
    useChat.setState({ activeAgent: null });
  });
  const contentOf = (gridId: string) => useGrids.getState().grids[gridId]!.panes.filter((p) => p.rect).map((p) => p.content);

  it("a click on one showing in a grid shows that grid and points its pane out, from a group too", () => {
    layOut(MAIN_GRID, "halves");
    const other = createGrid();
    useGrids.setState({ active: MAIN_GRID });
    layOut(other, "halves");
    deliver(other, { kind: "session", sessionId: "s1" });
    deliver(other, { kind: "agent", agent: "remote/ada" });
    groups();
    // api-e7 (s1) is in Acme.
    fireEvent.click(row("api-e7"));
    const s = useGrids.getState();
    const pane = s.grids[other]!.panes.find((p) => p.content?.kind === "session")!;
    expect(useDesk.getState().view).toBe("grids");
    expect(s.active).toBe(other);
    expect(s.flash).toMatchObject({ gridId: other, paneIds: [pane.id] });
    expect(s.focus[other]).toBe(pane.id);
    expect(useDesk.getState().openId).toBeNull();

    useDesk.setState({ view: "floor" });
    fireEvent.click(row("Ada"));
    expect(useDesk.getState().view).toBe("grids");
    expect(useGrids.getState().flash?.paneIds).toEqual([useGrids.getState().grids[other]!.panes.find((p) => p.content?.kind === "agent")!.id]);
    expect(useChat.getState().activeAgent).toBeNull();
  });

  it("a click on one in no grid (or only parked in one) opens it as before", () => {
    layOut(MAIN_GRID, "one");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s2" });
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    layOut(MAIN_GRID, "one");
    expect(contentOf(MAIN_GRID)).toEqual([{ kind: "session", sessionId: "s1" }]);
    const view = useDesk.getState().view;
    groups();
    fireEvent.click(row("web-release"));
    expect(useDesk.getState().openId).toBe("s2");
    // As before, but where you are (the Floor too): a session opens as a
    // column beside what's shown.
    expect(useDesk.getState().view).toBe(view);
    expect(useGrids.getState().flash).toBeNull();
  });

  it("adds one to a grid from its menu: the first empty pane, else beside the largest, or a new grid", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
    useGrids.setState((s) => ({ grids: { ...s.grids, [MAIN_GRID]: { ...s.grids[MAIN_GRID]!, name: "Release" } } }));
    groups();
    const add = (name: string, grid: string) => {
      fireEvent.contextMenu(row(name));
      fireEvent.click(screen.getByRole("menuitem", { name: "Add to grid" }));
      const sub = screen.getByRole("menu", { name: "Add to grid" });
      expect(within(sub).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([...useGrids.getState().order.map((id) => useGrids.getState().grids[id]!.name), "New grid"]);
      fireEvent.click(within(sub).getByRole("menuitem", { name: grid }));
    };
    add("web-release", "Release");
    expect(contentOf(MAIN_GRID)).toEqual([
      { kind: "session", sessionId: "s1" },
      { kind: "session", sessionId: "s2" },
    ]);
    expect(useDesk.getState().view).toBe("grids");
    add("Scout", "Release");
    const shown = useGrids.getState().grids[MAIN_GRID]!.panes.filter((p) => p.rect);
    expect(shown).toHaveLength(3);
    expect(shown.find((p) => p.content?.kind === "agent")!.rect).toEqual({ x: 0, y: 6, w: 6, h: 6 });
    add("Ada", "New grid");
    const fresh = useGrids.getState().order.at(-1)!;
    expect(fresh).not.toBe(MAIN_GRID);
    expect(contentOf(fresh)).toEqual([{ kind: "agent", agent: "remote/ada" }]);
    expect(useGrids.getState().active).toBe(fresh);
  });

  it("with no grids, Add to grid offers only New grid, which makes one holding it", () => {
    deleteGrid(MAIN_GRID, closeContent);
    expect(useGrids.getState().order).toEqual([]);
    groups();
    fireEvent.contextMenu(row("Scout"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to grid" }));
    const sub = screen.getByRole("menu", { name: "Add to grid" });
    expect(within(sub).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["New grid"]);
    expect(within(sub).queryByRole("separator")).toBeNull();
    fireEvent.click(within(sub).getByRole("menuitem", { name: "New grid" }));
    const [fresh] = useGrids.getState().order;
    expect(useGrids.getState().order).toHaveLength(1);
    expect(contentOf(fresh!)).toEqual([{ kind: "agent", agent: "local/scout" }]);
    expect(useGrids.getState().active).toBe(fresh);
    expect(useDesk.getState().view).toBe("grids");
  });
  describe("the item whose pane has focus", () => {
    const lit = () => screen.getAllByRole("button").filter((b) => b.classList.contains("in-focus")).map((b) => b.querySelector(".gi-name")!.textContent);
    const paneOf = (gridId: string, sessionOrAgent: string) =>
      useGrids.getState().grids[gridId]!.panes.find((p) => (p.content?.kind === "session" ? p.content.sessionId : p.content?.kind === "agent" ? p.content.agent : p.content?.kind === "terminal" ? p.content.terminalId : null) === sessionOrAgent)!.id;
    beforeEach(() => {
      useDesk.setState({ view: "grids" });
      Element.prototype.scrollIntoView = vi.fn();
    });

    it("is lit as focus moves between panes and grids, and not outside the Grids view", () => {
      layOut(MAIN_GRID, "halves");
      deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
      deliver(MAIN_GRID, { kind: "agent", agent: "local/scout" });
      const other = createGrid();
      deliver(other, { kind: "terminal", terminalId: "t2" });
      useDesk.setState((s) => ({ sessions: { ...s.sessions, s2: { ...s.sessions.s2!, live: true, terminalId: "t2" } } }));
      setActive(MAIN_GRID);
      groups();
      expect(lit()).toEqual(["Scout"]);
      act(() => setFocus(MAIN_GRID, paneOf(MAIN_GRID, "s1")));
      expect(lit()).toEqual(["api-e7"]);
      // Another grid: its focused pane, a terminal web-release runs in.
      act(() => setActive(other));
      expect(lit()).toEqual(["web-release"]);
      act(() => useDesk.setState({ view: "floor" }));
      expect(lit()).toEqual([]);
      act(() => useDesk.setState({ view: "grids" }));
      // No pane focused there any more.
      act(() => useGrids.setState((s) => ({ focus: { ...s.focus, [other]: "gone" } })));
      expect(lit()).toEqual([]);
    });

    it("opens its group if it was collapsed, once, and scrolls its row into view", () => {
      useSettings.setState({ groups: [{ ...ACME, collapsed: true }, BETA] });
      layOut(MAIN_GRID, "halves");
      deliver(MAIN_GRID, { kind: "session", sessionId: "s2" });
      deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
      groups();
      expect(useSettings.getState().groups.find((g) => g.id === "acme")!.collapsed).toBe(false);
      expect(lit()).toEqual(["api-e7"]);
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      // Collapsed again by hand while it still has focus, it stays so.
      fireEvent.click(header("Acme"));
      expect(useSettings.getState().groups.find((g) => g.id === "acme")!.collapsed).toBe(true);
      // Focus moving away and back opens it again.
      act(() => setFocus(MAIN_GRID, paneOf(MAIN_GRID, "s2")));
      act(() => setFocus(MAIN_GRID, paneOf(MAIN_GRID, "s1")));
      expect(useSettings.getState().groups.find((g) => g.id === "acme")!.collapsed).toBe(false);
    });

    it("opens a closed Groups section too, so its row shows", () => {
      setSectionOpen("groups", false);
      layOut(MAIN_GRID, "halves");
      deliver(MAIN_GRID, { kind: "session", sessionId: "s1" });
      groups();
      expect(useSections.getState().closed.groups).toBeUndefined();
      expect(lit()).toEqual(["api-e7"]);
    });

    it("points out its panes in the grid shown once the pointer rests on it", () => {
      vi.useFakeTimers();
      try {
        layOut(MAIN_GRID, "halves");
        deliver(MAIN_GRID, { kind: "session", sessionId: "s2" });
        deliver(MAIN_GRID, { kind: "terminal", terminalId: "t2" });
        useDesk.setState((s) => ({ sessions: { ...s.sessions, s2: { ...s.sessions.s2!, live: true, terminalId: "t2" } } }));
        groups();
        const rest = () => act(() => void vi.advanceTimersByTime(HOVER_MS));
        fireEvent.pointerEnter(row("web-release"));
        act(() => void vi.advanceTimersByTime(HOVER_MS - 1));
        expect(useGrids.getState().flash).toBeNull();
        rest();
        expect(useGrids.getState().flash).toMatchObject({ gridId: MAIN_GRID, paneIds: [paneOf(MAIN_GRID, "s2"), paneOf(MAIN_GRID, "t2")] });
        // Passing over a row on the way somewhere points out nothing.
        useGrids.setState({ flash: null });
        fireEvent.pointerEnter(row("web-release"));
        fireEvent.pointerLeave(row("web-release"));
        rest();
        expect(useGrids.getState().flash).toBeNull();
        // While a pane fills the grid, only that one is in sight.
        act(() => toggleFill(MAIN_GRID, paneOf(MAIN_GRID, "t2")));
        fireEvent.pointerEnter(row("web-release"));
        rest();
        expect(useGrids.getState().flash?.paneIds).toEqual([paneOf(MAIN_GRID, "t2")]);
        // One in no pane here points out nothing.
        useGrids.setState({ flash: null });
        fireEvent.pointerEnter(row("Ada"));
        rest();
        expect(useGrids.getState().flash).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("a machine's sessions, in the same groups", () => {
  const devbox = (state = "ready") => ({ id: "devbox", name: "devbox", target: "devbox", version: null, state: { kind: state } }) as never;
  const remote = (id: string, name: string, more: Partial<Session> = {}) => ({ ...session(id, name, more), machine: "devbox" });
  const tag = (name: string) => row(name).querySelector(".gi-machine");

  beforeEach(() => {
    useMachines.setState({ machines: [devbox()], listed: true });
    useMachineSessions.setState({ seen: {}, merged: [] });
    useDesk.setState({
      sessions: { ...useDesk.getState().sessions, "devbox/d1": remote("d1", "acme-web", { state: "blocked" }), "devbox/d2": remote("d2", "cufflink") },
      engines: { devbox: { hub: null as never, connected: true, loaded: true, error: null } },
    });
    useSettings.setState({ groups: [{ ...ACME, items: [...ACME.items, "session:devbox/d1"] }, BETA] });
  });
  afterEach(() => {
    useMachines.setState({ machines: [], listed: false });
    useDesk.setState({ engines: {} });
  });

  it("sit in any group, or Ungrouped, ordered as this computer's are, each with its machine's tag", () => {
    groups();
    expect(rows("Acme")).toEqual(["Scout", "api-e7", "acme-web"]);
    expect(rows("Ungrouped")).toEqual(["Ada", "web-release", "cufflink"]);
    expect(tag("acme-web")?.textContent).toBe("devbox");
    expect(tag("acme-web")?.className).toContain("chip");
    expect(tag("acme-web")?.className).not.toContain("chip-machine-off");
    // The tag comes before what it's waiting on.
    expect(row("acme-web").textContent).toMatch(/acme-web.*devbox.*needs you/);
    expect(tag("api-e7")).toBeNull();
    expect(screen.queryByText("This Mac")).toBeNull();
  });

  it("move between groups and back to Ungrouped, by keyboard and menu, as the layout's machine-qualified item", () => {
    groups();
    fireEvent.keyDown(row("acme-web"), { key: "ArrowDown", altKey: true });
    expect(rows("Beta")).toEqual(["acme-web"]);
    expect((lastSaved().groups as DeskGroup[])[1]!.items).toEqual(["session:devbox/d1"]);
    fireEvent.contextMenu(row("cufflink"));
    expect(screen.queryByRole("menuitem", { name: /Take over|boss/i })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /Move to group/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Acme" }));
    expect(rows("Acme")).toEqual(["Scout", "api-e7", "cufflink"]);
    fireEvent.contextMenu(row("acme-web"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from group" }));
    expect(rows("Ungrouped")).toEqual(["Ada", "web-release", "acme-web"]);
    fireEvent.click(row("cufflink"));
    expect(useDesk.getState().openId).toBe("devbox/d2");
  });

  it("an offline machine's sessions keep their places, as last seen, shown offline", () => {
    useMachines.setState({ machines: [devbox("unreachable")] });
    useMachineSessions.setState({ seen: { "devbox/d1": { name: "acme-web", engine: "claude" }, "devbox/d9": { name: "atlas-etl", engine: "codex", displayName: "ETL" } }, merged: [] });
    // Desk started without reaching it: no engine, none of its sessions.
    const { s1, s2 } = useDesk.getState().sessions;
    useDesk.setState({ sessions: { s1: s1!, s2: s2! }, engines: {} });
    useSettings.setState({ groups: [{ ...ACME, items: [...ACME.items, "session:devbox/d1"] }, { ...BETA, items: ["session:devbox/d9"] }] });
    groups();
    expect(rows("Acme")).toEqual(["Scout", "api-e7", "acme-web"]);
    expect(rows("Beta")).toEqual(["ETL"]);
    expect(tag("acme-web")?.className).toContain("chip-machine-off");
    expect(tag("acme-web")?.getAttribute("title")).toBe("devbox is offline");
    expect(row("acme-web").textContent).toContain("offline");
    expect(row("acme-web").querySelector(".dot")?.className).toContain("dot-idle");
    // Still moved as any other; nothing else is offered while it's away.
    fireEvent.contextMenu(row("ETL"));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Move to group▸", "Remove from group"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from group" }));
    expect(rows("Ungrouped")).toEqual(["Ada", "web-release", "ETL"]);
  });

  it("a machine removed from Desk: its sessions leave the sidebar", () => {
    useMachineSessions.setState({ seen: { "devbox/d1": { name: "acme-web", engine: "claude" } }, merged: [] });
    useDesk.setState({ sessions: { s1: useDesk.getState().sessions.s1! }, engines: {} });
    groups();
    expect(rows("Acme")).toEqual(["Scout", "api-e7", "acme-web"]);
    act(() => useMachines.setState({ machines: [] }));
    expect(rows("Acme")).toEqual(["Scout", "api-e7"]);
  });
});

describe("picking rows and acting on them together", () => {
  const devbox = { id: "devbox", name: "devbox", target: "devbox", version: null, state: { kind: "ready" } } as never;
  const nothing: Closing = { folder: "/tmp", work: null, changes: null, pulls: [], tickets: [] };
  const unreachable = new Error("devbox didn't answer");
  const here = {
    end: vi.fn((id: string) => Promise.resolve(session(id, id, { state: "closed" }))),
    remove: vi.fn((_id: string, _transcript: boolean) => Promise.resolve({ transcript: false })),
    stop: vi.fn((_id: string) => Promise.resolve()),
    closing: vi.fn((id: string): Promise<Closing> =>
      Promise.resolve(
        id === "s1"
          ? { folder: "/Users/kings/dev/api", work: "it's working", changes: "2 uncommitted files", pulls: [12], tickets: ["MAN-491"] }
          : nothing,
      ),
    ),
  };
  const there = {
    end: vi.fn(() => Promise.reject(unreachable)),
    remove: vi.fn((_id: string, _transcript: boolean) => Promise.reject(unreachable)),
    stop: vi.fn((_id: string) => Promise.resolve()),
    closing: vi.fn(() => Promise.reject(new Error("an older Desk"))),
  };
  const picked = () => [...useSelection.getState().keys].sort();
  const bar = () => screen.queryByRole("toolbar", { name: "Selection" });
  const cmd = (...names: string[]) => names.forEach((name) => fireEvent.click(row(name), { metaKey: true }));
  const buttons = () => within(bar()!).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
  const labels = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((m) => m.textContent);

  beforeEach(() => {
    Object.values(here).forEach((f) => f.mockClear());
    Object.values(there).forEach((f) => f.mockClear());
    useMachines.setState({ machines: [devbox], listed: true });
    useMachineSessions.setState({ seen: {}, merged: [] });
    useDesk.setState({
      hub: here as never,
      sessions: { ...useDesk.getState().sessions, "devbox/d1": { ...session("d1", "acme-web"), machine: "devbox" } },
      engines: { devbox: { hub: there as never, connected: true, loaded: true, error: null } },
    });
    useSettings.setState({ groups: [{ ...ACME, items: [...ACME.items, "session:devbox/d1"] }, BETA] });
  });
  afterEach(() => {
    clearSelection();
    useHost.setState(DEFAULT_HOST);
    useMachines.setState({ machines: [], listed: false });
    useDesk.setState({ engines: {}, hub: null });
    useUnread.setState({ local: null, machines: {}, dms: {} });
    useReads.setState({ local: {}, dms: {} });
  });

  it("picks the row clicked alone and opens it, letting go of every other", () => {
    groups();
    cmd("acme-web", "web-release");
    expect(bar()?.textContent).toContain("2 selected");
    fireEvent.click(row("api-e7"));
    expect(picked()).toEqual(["session:s1"]);
    expect(useDesk.getState().openId).toBe("s1");
    expect(bar()).toBeNull();
    expect(screen.getAllByRole("button").some((b) => b.classList.contains("selected"))).toBe(false);
  });

  it("adds with cmd-click and a range with shift-click, opening none, and draws them picked only once two are; Escape lets go", () => {
    groups();
    cmd("api-e7");
    expect(picked()).toEqual(["session:s1"]);
    expect(bar()).toBeNull();
    expect(row("api-e7").hasAttribute("aria-pressed")).toBe(false);
    fireEvent.click(row("web-release"), { shiftKey: true });
    expect(picked()).toEqual(["agent:remote/ada", "session:devbox/d1", "session:s1", "session:s2"]);
    expect(bar()?.textContent).toContain("4 selected");
    expect(row("Ada").className).toContain("selected");
    cmd("acme-web");
    expect(picked()).toEqual(["agent:remote/ada", "session:s1", "session:s2"]);
    expect(row("acme-web").getAttribute("aria-pressed")).toBe("false");
    // Ctrl on a Mac isn't the pick: only ⌘ is.
    expect(useDesk.getState().openId).toBeNull();
    fireEvent.click(row("acme-web"), { ctrlKey: true });
    expect(picked()).toEqual(["session:devbox/d1"]);
    expect(useDesk.getState().openId).toBe("devbox/d1");
    cmd("api-e7");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(bar()).toBeNull();
    // The row open is picked again, so the next ⌘-click adds to it.
    expect(picked()).toEqual(["session:devbox/d1"]);
    cmd("api-e7");
    expect(bar()?.textContent).toContain("2 selected");
  });

  it("lets the only row picked be ⌘-clicked off, as Finder does", () => {
    groups();
    fireEvent.click(row("api-e7"));
    cmd("api-e7");
    expect(picked()).toEqual([]);
    cmd("web-release");
    expect(picked()).toEqual(["session:s2"]);
  });

  it("keeps focus on a row picked with a modifier, so the keys that act on picks reach it", () => {
    groups();
    cmd("api-e7", "web-release");
    expect(document.activeElement).toBe(row("web-release"));
    fireEvent.click(row("acme-web"), { shiftKey: true });
    expect(document.activeElement).toBe(row("acme-web"));
    fireEvent.keyDown(document.activeElement!, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu", { name: "4 selected" })).toBeTruthy();
  });

  it("picks with Ctrl on Windows, any row (agents, and sessions whose machine can't be reached), and keeps the picks as the sidebar is drawn again", () => {
    useHost.setState({ platform: "windows" });
    useMachines.setState({ machines: [{ ...(devbox as object), state: { kind: "unreachable" } } as never] });
    const { unmount } = groups();
    for (const name of ["Scout", "acme-web", "web-release"]) fireEvent.click(row(name), { ctrlKey: true });
    expect(picked()).toEqual(["agent:local/scout", "session:devbox/d1", "session:s2"]);
    unmount();
    groups();
    expect(row("acme-web").className).toContain("selected");
    // Only a session whose machine is there can be removed or closed.
    expect(buttons()).toEqual(["Actions ▾", "Clear selection", "Close 1 session", "Remove 1 session"]);
  });

  it("pins the bar above the rows, saying how many and what each choice is for", () => {
    groups();
    cmd("Scout", "api-e7", "acme-web");
    const body = screen.getByRole("region", { name: "Groups" }).querySelector(".side-section-body")!;
    expect(body.firstElementChild).toBe(bar());
    expect(bar()?.textContent).toContain("3 selected");
    expect(buttons()).toEqual(["Actions ▾", "Clear selection", "Close 2 sessions", "Remove 2 sessions"]);
    expect(within(bar()!).getByRole("button", { name: "Remove 2 sessions" }).textContent).toBe("Remove 2");
    fireEvent.click(within(bar()!).getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menu", { name: "3 selected" })).toBeTruthy();
    fireEvent.click(within(bar()!).getByRole("button", { name: "Clear selection" }));
    expect(bar()).toBeNull();
  });

  it("right-click on a picked row acts on them all; on another, picks it alone and acts on it", () => {
    useDesk.setState((s) => ({ sessions: { ...s.sessions, s1: { ...s.sessions.s1!, live: true }, s2: { ...s.sessions.s2!, live: true } } }));
    groups();
    cmd("Scout", "api-e7", "web-release");
    fireEvent.contextMenu(row("api-e7"));
    const menu = screen.getByRole("menu", { name: "3 selected" });
    expect(labels(menu)).toEqual([
      "Move 3 to group▸",
      "Add 3 to grid▸",
      "Remove 2 from group · 1 can’t",
      "Stop 2 sessions · 1 can’t",
      "Notifications for 1 agent▸",
      "Close 2 sessions… · 1 can’t be closed",
      "Remove 2 sessions… · 1 can’t be removed⌫",
      "Clear selectionEsc",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Stop 2 sessions/ }));
    expect(here.stop.mock.calls.map(([id]) => id).sort()).toEqual(["s1", "s2"]);
    expect(picked()).toEqual(["agent:local/scout", "session:s1", "session:s2"]);

    fireEvent.contextMenu(row("acme-web"));
    expect(picked()).toEqual(["session:devbox/d1"]);
    expect(screen.getByRole("menu", { name: "acme-web options" })).toBeTruthy();
    expect(bar()).toBeNull();
  });

  it("moves them all to a group, and back out of theirs", async () => {
    groups();
    cmd("api-e7", "web-release");
    fireEvent.contextMenu(row("api-e7"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move 2 to group" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Move 2 to group" })).getByRole("menuitem", { name: "Beta" }));
    await act(async () => {});
    expect(rows("Beta")).toEqual(["api-e7", "web-release"]);
    expect(picked()).toEqual(["session:s1", "session:s2"]);
    fireEvent.contextMenu(row("api-e7"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove 2 from group" }));
    await act(async () => {});
    expect(rows("Beta")).toEqual([]);
    expect(rows("Ungrouped")).toEqual(expect.arrayContaining(["api-e7", "web-release"]));
  });

  it("marks those with something unread read, and those read already that left something unread again", () => {
    useDesk.setState((s) => ({ sessions: { ...s.sessions, s1: { ...s.sessions.s1!, state: "done" } } }));
    useUnread.setState({
      local: { rooms: [], sessions: [{ id: "s2", since: "2026-10-29T09:00:00Z", urgency: "forYou" }], activity: { count: 0, lastAt: null }, brief: null, update: null, floor: "2026-01-01T00:00:00Z" },
    });
    groups();
    cmd("api-e7", "web-release", "Scout");
    fireEvent.contextMenu(row("api-e7"));
    const menu = screen.getByRole("menu", { name: "3 selected" });
    expect(labels(menu)).toEqual(expect.arrayContaining(["Mark 1 read · 2 can’t", "Mark 1 unread · 2 can’t"]));
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Mark 1 read/ }));
    expect(useReads.getState().local["session:s2"]).toEqual({ at: "2026-10-29T09:00:00Z", message: null });
    fireEvent.contextMenu(row("api-e7"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Mark 1 unread/ }));
    expect(instant(useReads.getState().local["session:s1"]!.at) < instant("2026-10-29T08:00:00Z")).toBe(true);
  });

  it("removes them in one confirm with the count, and keeps the refused picked saying why", async () => {
    useDesk.setState((s) => ({ sessions: { ...s.sessions, s2: { ...s.sessions.s2!, origin: "external", state: "working" } } }));
    groups();
    cmd("Scout", "api-e7", "acme-web", "web-release");
    fireEvent.keyDown(row("Scout"), { key: "Delete" });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Remove 3 sessions?");
    expect(dialog.textContent).toContain("1 of them keeps running in their own terminals; Desk stops tracking them.");
    expect(within(dialog).getByText("Runs in its own terminal: it keeps running there, and Desk stops tracking it.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove 3" }));
    expect(await within(screen.getByRole("dialog")).findByText(plainError(unreachable))).toBeTruthy();
    expect(here.remove.mock.calls.map(([id]) => id).sort()).toEqual(["s1", "s2"]);
    expect(there.remove).toHaveBeenCalledWith("d1", false);
    expect(picked()).toEqual(["session:devbox/d1"]);
    expect(await within(screen.getByRole("dialog")).findByText(/1 of 3 weren’t removed/)).toBeTruthy();
  });

  it("closes them in one confirm that says what each would leave, as End session does, and keeps the refused saying why", async () => {
    groups();
    cmd("api-e7", "acme-web", "web-release");
    fireEvent.click(within(bar()!).getByRole("button", { name: "Close 3 sessions" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Close 3 sessions?");
    expect(await within(dialog).findByText("it's working · 2 uncommitted files · PR #12 still open · MAN-491 still open")).toBeTruthy();
    expect(within(dialog).getByText("~/dev/api")).toBeTruthy();
    expect(await within(dialog).findByText("Nothing left behind.")).toBeTruthy();
    expect(await within(dialog).findByText("What it would leave couldn’t be checked.")).toBeTruthy();
    expect(here.closing.mock.calls.map(([id]) => id).sort()).toEqual(["s1", "s2"]);
    expect(there.closing).toHaveBeenCalledWith("d1");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close 3" }));
    expect(await within(screen.getByRole("dialog")).findByText(plainError(unreachable))).toBeTruthy();
    expect(here.end.mock.calls.map(([id]) => id).sort()).toEqual(["s1", "s2"]);
    expect(there.end).toHaveBeenCalledWith("d1");
    expect(picked()).toEqual(["session:devbox/d1"]);
    expect(await within(screen.getByRole("dialog")).findByText(/1 of 3 weren’t closed/)).toBeTruthy();
    expect(within(screen.getByRole("dialog")).getByRole("heading").textContent).toBe("Close 1 session?");
  });

  it("keeps the refused picked when the row open was among those closed", async () => {
    groups();
    fireEvent.click(row("api-e7"));
    cmd("acme-web", "web-release");
    fireEvent.click(within(bar()!).getByRole("button", { name: "Close 3 sessions" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close 3" }));
    expect(await within(screen.getByRole("dialog")).findByText(plainError(unreachable))).toBeTruthy();
    act(() => useDesk.setState((s) => ({ sessions: { ...s.sessions, s1: { ...s.sessions.s1!, state: "closed" } } })));
    expect(picked()).toEqual(["session:devbox/d1"]);
    expect(within(screen.getByRole("dialog")).getByRole("heading").textContent).toBe("Close 1 session?");
  });

  it("lets go of rows out of sight, and picks a whole group from its menu", () => {
    groups();
    cmd("api-e7", "web-release");
    fireEvent.click(header("Acme"));
    expect(picked()).toEqual(["session:s2"]);
    fireEvent.click(screen.getByRole("button", { name: "Acme options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select all in Acme" }));
    expect(picked()).toEqual(["agent:local/scout", "session:devbox/d1", "session:s1"]);
    expect(rows("Acme")).toEqual(["Scout", "api-e7", "acme-web"]);
    expect(bar()?.textContent).toContain("3 selected");
  });

  it("follows the row opened from elsewhere while one or none is picked", () => {
    groups();
    fireEvent.click(row("api-e7"));
    act(() => useDesk.setState({ openId: "s2" }));
    expect(picked()).toEqual(["session:s2"]);
    cmd("api-e7");
    act(() => useDesk.setState({ openId: null }));
    expect(picked()).toEqual(["session:s1", "session:s2"]);
  });
});
