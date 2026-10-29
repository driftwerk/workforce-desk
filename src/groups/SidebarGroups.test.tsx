import { invoke } from "@tauri-apps/api/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import { Tile } from "../floor/SessionTile";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { SessionCard } from "../session/SessionCard";
import { useSettings } from "../settings/store";
import { EMPTY_LAYOUT, type DeskGroup } from "./model";
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

const ACME: DeskGroup = { id: "acme", name: "Acme", collapsed: false, items: ["agent:local/scout", "session:s1"] };
const BETA: DeskGroup = { id: "beta", name: "Beta", collapsed: false, items: [] };

const saves = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "settings_save");
const lastSaved = () => (saves().at(-1)?.[1] as { settings: Record<string, unknown> }).settings;

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  useChat.setState({
    hubs: [
      { id: "local", label: "This Mac", url: "", local: true, token: "" },
      { id: "remote", label: "Office", url: "", local: false, token: "" },
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

const groups = () => render(<SidebarGroups onNewSession={() => {}} newSessionKeys="⌘N" onNewCrew={() => {}} />);
const section = (name: string) => screen.getByRole("region", { name });
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

  it("agents can't be renamed here", () => {
    groups();
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
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Groups", "Beta", "Acme", "Ungrouped"]);
    expect(document.activeElement).toBe(header("Beta"));
  });

  it("moves an item to a group from its menu, with the keyboard", () => {
    groups();
    fireEvent.keyDown(row("web-release"), { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "web-release options" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["RenameF2", "Move to group▸", "Open"]);
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
    expect(screen.queryByRole("region", { name: "Acme Labs" })).toBeNull();
    expect(rows("Ungrouped")).toEqual(["Ada", "web-release", "Scout", "api-e7"]);
    expect((lastSaved().groups as DeskGroup[]).map((g) => g.id)).toEqual(["beta"]);
  });

  it("Ungrouped has no handle, options or rename", () => {
    groups();
    expect(screen.queryByRole("button", { name: "Ungrouped options" })).toBeNull();
    fireEvent.keyDown(header("Ungrouped"), { key: "F2" });
    expect(screen.queryByRole("textbox")).toBeNull();
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
