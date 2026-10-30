import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { deliver, layOut, startGrids, useGrids } from "../grids/store";
import { EMPTY_LAYOUT } from "../groups/model";
import { SidebarGroups } from "../groups/SidebarGroups";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { ItemTile } from "../overview/ItemTile";
import { Stage, type OpenPanel } from "../panels/Stage";
import { SessionCard } from "../session/SessionCard";
import { useSettings } from "../settings/store";
import { useUi } from "../shell/ui";
import { AgentPanel, useAgentPanel } from "./AgentPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));

/** A DM's socket that never connects: the conversation shows, waiting. */
class QuietSocket {
  static OPEN = 1;
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  close() {}
  send() {}
}

Element.prototype.scrollIntoView = () => {};

const agent = (hubId: string, id: string, name: string): Agent => ({ hubId, id, name, model: null, provider: null, isDefault: false });

const session: Session = {
  id: "s1",
  engine: "claude",
  name: "api-e7",
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
};

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, v), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

/** The sidebar and the main area with its columns, as App puts them. */
function Desk() {
  const beside = useAgentPanel();
  const open = useDesk((s) => (s.openId ? s.sessions[s.openId] : undefined));
  const panels: OpenPanel[] = [];
  if (beside) panels.push({ kind: "agent", label: beside.name, element: <AgentPanel agent={beside} /> });
  if (open) panels.push({ kind: "session", label: open.name, element: <SessionCard session={open} /> });
  return (
    <>
      <SidebarGroups />
      <Stage main={<div>main</div>} mainKey="floor" mainName="Floor" panels={panels} />
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", QuietSocket);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  useChat.setState({
    hubs: [
      { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, token: "t" },
      { id: "remote", label: "Office", url: "http://127.0.0.1:2", local: false, token: "t" },
    ],
    roster: [agent("local", "scout", "Scout"), agent("remote", "ada", "Ada")],
    activeAgent: null,
    panelAgent: null,
    rosterRead: true,
  });
  useDesk.setState({ view: "floor", activeRoom: null, openId: null, sessions: { s1: session }, rooms: {} });
  useSettings.setState({ loaded: true, groups: [], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
  useUi.setState({ panelWidths: {}, panelFocus: null });
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (name: string) => screen.getAllByRole("button").find((b) => b.dataset.item && b.querySelector(".gi-name")?.textContent === name)!;
const panel = () => document.querySelector<HTMLElement>('[data-panel="agent"]');
const shownIn = (el: HTMLElement | null) => (el ? within(el).getByRole("complementary").getAttribute("aria-label") : null);

describe("an agent clicked on the Floor", () => {
  it("opens their DM beside the Floor, and the Floor stays", () => {
    render(<Desk />);
    fireEvent.click(row("Scout"));
    expect(useDesk.getState().view).toBe("floor");
    expect(useChat.getState()).toMatchObject({ panelAgent: "local/scout", activeAgent: null });
    expect(shownIn(panel())).toBe("Scout");
    expect(within(panel()!).getByPlaceholderText("Message Scout")).toBeTruthy();
    expect(row("Scout").getAttribute("aria-current")).toBe("true");
  });

  it("from a Floor tile too", () => {
    render(
      <>
        <ItemTile item={{ kind: "agent", id: "scout", name: "Scout", state: "working", task: "Deploying" }} />
        <Desk />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Scout.*working/ }));
    expect(useDesk.getState().view).toBe("floor");
    expect(shownIn(panel())).toBe("Scout");
  });

  it("puts a second agent in the panel in place of the first", () => {
    render(<Desk />);
    fireEvent.click(row("Scout"));
    fireEvent.click(row("Ada"));
    expect(useChat.getState().panelAgent).toBe("remote/ada");
    expect(document.querySelectorAll('[data-panel="agent"]')).toHaveLength(1);
    expect(shownIn(panel())).toBe("Ada");
    expect(within(panel()!).getByPlaceholderText("Message Ada")).toBeTruthy();
  });

  it("sits beside a session's card as two columns", () => {
    render(<Desk />);
    fireEvent.click(row("Scout"));
    fireEvent.click(row("api-e7"));
    expect(useDesk.getState().openId).toBe("s1");
    expect([...document.querySelectorAll(".rpanel-slot")].map((s) => [s.getAttribute("data-panel"), s.classList.contains("rpanel-column")])).toEqual([
      ["agent", true],
      ["session", true],
    ]);
  });

  it("shows the grid instead when the agent is in one", () => {
    layOut(MAIN_GRID, "halves");
    deliver(MAIN_GRID, { kind: "agent", agent: "remote/ada" });
    render(<Desk />);
    fireEvent.click(row("Ada"));
    expect(useDesk.getState().view).toBe("grids");
    expect(useGrids.getState().flash?.paneId).toBe(useGrids.getState().grids[MAIN_GRID]!.panes.find((p) => p.content?.kind === "agent")!.id);
    expect(useChat.getState()).toMatchObject({ panelAgent: null, activeAgent: null });
  });

  it("is only beside the Floor: away from it the panel is out of sight, and back on it, it's there again", () => {
    render(<Desk />);
    fireEvent.click(row("Scout"));
    act(() => useDesk.getState().setView("grids"));
    expect(panel()).toBeNull();
    act(() => useDesk.getState().setView("floor"));
    expect(shownIn(panel())).toBe("Scout");
  });
});

describe("an agent clicked in Rooms or Grids", () => {
  it.each(["rooms", "grids"] as const)("opens their DM in Rooms as before, from %s", (view) => {
    useDesk.setState({ view });
    render(<Desk />);
    fireEvent.click(row("Scout"));
    expect(useDesk.getState().view).toBe("rooms");
    expect(useChat.getState()).toMatchObject({ activeAgent: "local/scout", panelAgent: null });
    expect(panel()).toBeNull();
  });
});

describe("the DM beside the Floor", () => {
  const opened = () => {
    render(<Desk />);
    fireEvent.click(row("Scout"));
    return within(panel()!);
  };

  it("goes into a grid from Put in grid, shown there, and leaves the side", () => {
    const p = opened();
    fireEvent.click(p.getByRole("button", { name: "Put Scout in a grid" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New grid" }));
    const fresh = useGrids.getState().order.at(-1)!;
    expect(useGrids.getState().grids[fresh]!.panes.filter((x) => x.rect).map((x) => x.content)).toEqual([{ kind: "agent", agent: "local/scout" }]);
    expect(useGrids.getState().active).toBe(fresh);
    expect(useDesk.getState().view).toBe("grids");
    expect(useChat.getState().panelAgent).toBeNull();
  });

  it("opens in full in Rooms", () => {
    const p = opened();
    fireEvent.click(p.getByRole("button", { name: "Open full" }));
    expect(useDesk.getState().view).toBe("rooms");
    expect(useChat.getState()).toMatchObject({ activeAgent: "local/scout", panelAgent: null });
  });

  it("opens the agent's Settings in Rooms", () => {
    const p = opened();
    fireEvent.click(p.getByRole("button", { name: "Settings" }));
    expect(useDesk.getState().view).toBe("rooms");
    expect(useChat.getState()).toMatchObject({ activeAgent: "local/scout", panelAgent: null });
    expect(useUi.getState().agentTabs["local/scout"]).toBe("settings");
  });

  it("focuses to fill the main area, and closes", () => {
    const p = opened();
    fireEvent.click(p.getByRole("button", { name: "Focus this conversation" }));
    expect(useUi.getState().panelFocus).toEqual({ kind: "agent", beside: null });
    expect(panel()!.classList.contains("rpanel-focused")).toBe(true);
    fireEvent.click(p.getByRole("button", { name: "Close this conversation" }));
    expect(useChat.getState().panelAgent).toBeNull();
    expect(useUi.getState().panelFocus).toBeNull();
    expect(panel()).toBeNull();
  });

  it("is resized on its own, with its own default width", () => {
    opened();
    const handle = screen.getByRole("separator", { name: "Resize Scout" });
    expect(handle.getAttribute("aria-valuenow")).toBe("480");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(useUi.getState().panelWidths).toEqual({ agent: 504 });
  });

  it("closes when the agent is removed", () => {
    opened();
    act(() => useChat.getState().forget("local/scout"));
    expect(useChat.getState().panelAgent).toBeNull();
  });
});

describe("an agent's Settings from the sidebar", () => {
  it("is in the agent's right-click menu", () => {
    render(<Desk />);
    fireEvent.contextMenu(row("Scout"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(useDesk.getState().view).toBe("rooms");
    expect(useChat.getState().activeAgent).toBe("local/scout");
    expect(useUi.getState().agentTabs["local/scout"]).toBe("settings");
  });
});
