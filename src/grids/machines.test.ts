import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { Session, TerminalInfo } from "../hub/types";
import { contentKey, findContent, sessionContent, sessionKeyIn, storedContent, terminalContent, terminalKeyIn, type Pane } from "./engine";
import { readGrid } from "./model";
import { closeContent, heardTerminals, openPaneTerminal, pluginEnv, sessionIn, terminalOf, trackedIn, useTerminals } from "./terminals";
import { startGrids, useGrids } from "./store";
import type { GridStorage } from "./storage";
import { itemOf } from "./where";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
const platform = vi.hoisted(() => ({ dirs: [] as (string | undefined)[] }));
vi.mock("../platform", () => ({
  inApp: false,
  claudePluginDir: vi.fn(async () => "/Applications/Desk.app/Contents/Resources/claude-plugin"),
  machinePluginDir: vi.fn(async (machine: string) => {
    platform.dirs.push(machine);
    return "/home/dev/.local/share/Desk/bin/current/claude-plugin";
  }),
  backendHome: vi.fn(async () => "/Users/me"),
  programsUnder: vi.fn(async () => []),
}));

const terminal = (id: string, over: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id,
  name: "acme-web",
  cwd: "/work/acme-web",
  envKeys: [],
  shell: "/bin/zsh",
  state: "running",
  live: true,
  exitCode: null,
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

const s = (id: string, over: Partial<Session> = {}) => ({ id, live: true, terminalId: null, cwd: "/w", updatedAt: "t", ...over }) as Session;

const pane = (id: string, content: Pane["content"]): Pane => ({ id, rect: { x: 0, y: 0, w: 12, h: 12 }, content });

describe("a pane's machine, stored", () => {
  it("reads a pane stored before machines as this computer's, and writes this computer's without one", () => {
    const old = readGrid({ id: "g", name: "Grid 2", panes: [pane("a", { kind: "session", sessionId: "s1" }), pane("b", { kind: "terminal", terminalId: "t1", cwd: "/w" })] });
    expect(old!.panes.map((p) => p.content)).toEqual([
      { kind: "session", sessionId: "s1" },
      { kind: "terminal", terminalId: "t1", cwd: "/w" },
    ]);
    // Unchanged panes are the very ones read.
    const raw = { id: "g", name: "G", panes: [pane("a", { kind: "session", sessionId: "s1" })] };
    expect(readGrid(raw)!.panes[0]).toBe(raw.panes[0]);
    expect(sessionKeyIn(old!.panes[0]!.content)).toBe("s1");
    expect(terminalKeyIn(old!.panes[1]!.content)).toBe("t1");
    // `local` written by anything is left out, as every stored pane has it.
    expect(readGrid({ id: "g", name: "G", panes: [pane("a", { kind: "session", sessionId: "s1", machine: "local" })] })!.panes[0]!.content).toEqual({
      kind: "session",
      sessionId: "s1",
    });
    expect(storedContent({ kind: "terminal", terminalId: null, machine: "local" })).toEqual({ kind: "terminal", terminalId: null });
    expect(sessionContent("s1")).toEqual({ kind: "session", sessionId: "s1" });
    expect(terminalContent("t1")).toEqual({ kind: "terminal", terminalId: "t1" });
  });

  it("keeps a machine's pane with its machine, and tells it from this computer's with the same id", () => {
    const theirs = readGrid({
      id: "g",
      name: "G",
      panes: [pane("a", { kind: "session", sessionId: "s1", machine: "devbox" }), pane("b", { kind: "terminal", terminalId: "t1", machine: "devbox" })],
    })!;
    expect(theirs.panes.map((p) => p.content)).toEqual([
      { kind: "session", sessionId: "s1", machine: "devbox" },
      { kind: "terminal", terminalId: "t1", machine: "devbox" },
    ]);
    expect(sessionKeyIn(theirs.panes[0]!.content)).toBe("devbox/s1");
    expect(terminalKeyIn(theirs.panes[1]!.content)).toBe("devbox/t1");
    expect(sessionContent("devbox/s1")).toEqual({ kind: "session", sessionId: "s1", machine: "devbox" });
    expect(terminalContent("devbox/t1", "/srv")).toEqual({ kind: "terminal", terminalId: "t1", cwd: "/srv", machine: "devbox" });
    expect(contentKey({ kind: "session", sessionId: "s1" })).toBe("session:s1");
    expect(contentKey({ kind: "session", sessionId: "s1", machine: "devbox" })).toBe("session:devbox/s1");
    expect(findContent(theirs.panes, { kind: "session", sessionId: "s1" })).toBeUndefined();
    expect(findContent(theirs.panes, sessionContent("devbox/s1"))?.id).toBe("a");
    // In the sidebar's terms, by key.
    expect(itemOf({}, theirs.panes[0]!.content)).toBe("session:devbox/s1");
  });

  it("keeps a machine in a grid's storage through a write", () => {
    const kept = new Map<string, unknown>();
    const storage = {
      get: (k: string) => kept.get(k),
      set: (k: string, v: unknown) => void kept.set(k, structuredClone(v)),
      remove: (k: string) => void kept.delete(k),
      subscribe: () => () => {},
    } as unknown as GridStorage;
    kept.set("grid.index", { order: ["main"] });
    kept.set("grid.main", { id: "main", name: "Main", placement: { kind: "main" }, panes: [pane("a", { kind: "terminal", terminalId: "t1", machine: "devbox" }), pane("b", { kind: "session", sessionId: "s1" })] });
    startGrids(storage, { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
    expect(useGrids.getState().grids.main!.panes.map((p) => p.content)).toEqual([
      { kind: "terminal", terminalId: "t1", machine: "devbox" },
      { kind: "session", sessionId: "s1" },
    ]);
  });
});

describe("terminals on several engines", () => {
  beforeEach(() => {
    useTerminals.setState({ byId: {}, known: false, knownOn: {}, programs: {}, problems: {} });
    useDesk.setState({ hub: null, engines: {}, sessions: {} });
  });

  it("are kept apart by engine, the same id on each", () => {
    heardTerminals({ type: "snapshot", sessions: [], restore: [], rooms: [], terminals: [terminal("t1")] });
    heardTerminals({ type: "snapshot", sessions: [], restore: [], rooms: [], terminals: [terminal("t1", { cwd: "/srv/web" })], machine: "devbox" });
    expect(Object.keys(useTerminals.getState().byId).sort()).toEqual(["devbox/t1", "t1"]);
    expect(useTerminals.getState()).toMatchObject({ known: true, knownOn: { devbox: true } });
    heardTerminals({ type: "terminalRemoved", id: "t1", machine: "devbox" });
    expect(Object.keys(useTerminals.getState().byId)).toEqual(["t1"]);
    // A machine's snapshot replaces only its own.
    heardTerminals({ type: "snapshot", sessions: [], restore: [], rooms: [], terminals: [], machine: "devbox" });
    expect(Object.keys(useTerminals.getState().byId)).toEqual(["t1"]);
  });

  it("know the session a terminal hosts on its own engine", () => {
    const sessions = { x: s("x", { terminalId: "t1" }), "devbox/y": s("y", { terminalId: "t1", machine: "devbox" }) };
    expect(trackedIn(sessions, "t1")?.id).toBe("x");
    expect(trackedIn(sessions, "devbox/t1")?.id).toBe("y");
    expect(sessionIn(sessions, { kind: "terminal", terminalId: "t1", machine: "devbox" })?.id).toBe("y");
    expect(sessionIn(sessions, { kind: "session", sessionId: "y", machine: "devbox" })?.machine).toBe("devbox");
    useDesk.setState({ sessions });
    heardTerminals({ type: "snapshot", sessions: [], restore: [], rooms: [], terminals: [terminal("t1")], machine: "devbox" });
    expect(terminalOf({ kind: "session", sessionId: "y", machine: "devbox" })).toBe("devbox/t1");
    expect(terminalOf({ kind: "session", sessionId: "x" })).toBeNull();
  });

  it("open on the pane's engine, with that machine's plugin folder, and close there", async () => {
    const mine = { openTerminal: vi.fn(), closeTerminal: vi.fn(() => Promise.resolve()) };
    const theirs = {
      openTerminal: vi.fn(async (t: { id: string; cwd: string }) => terminal(t.id, { cwd: t.cwd })),
      closeTerminal: vi.fn(() => Promise.resolve()),
    };
    useGrids.setState({ ready: true, role: { kind: "main" }, order: ["main"], grids: { main: { id: "main", name: "Main", placement: { kind: "main" }, panes: [pane("p1", { kind: "terminal", terminalId: null, machine: "devbox" })] } }, open: {} });
    useDesk.setState({
      hub: mine as unknown as DeskHub,
      engines: { devbox: { hub: theirs as unknown as DeskHub, connected: true, loaded: true, error: null } },
      sessions: { "devbox/y": s("y", { cwd: "/srv/web", machine: "devbox" }) },
    });
    await openPaneTerminal("main", "p1", null, "t9", "devbox");
    expect(mine.openTerminal).not.toHaveBeenCalled();
    // Where its latest session worked: the page can't ask a machine for its home.
    expect(theirs.openTerminal).toHaveBeenCalledWith({
      id: "t9",
      cwd: "/srv/web",
      env: { CLAUDE_CODE_PLUGIN_DIRS: "/home/dev/.local/share/Desk/bin/current/claude-plugin" },
    });
    expect(platform.dirs).toEqual(["devbox"]);
    expect(useTerminals.getState().byId["devbox/t9"]).toBeTruthy();
    expect(useGrids.getState().grids.main!.panes[0]!.content).toEqual({ kind: "terminal", terminalId: "t9", cwd: "/srv/web", machine: "devbox" });
    closeContent({ kind: "terminal", terminalId: "t9", machine: "devbox" });
    expect(theirs.closeTerminal).toHaveBeenCalledWith("t9");
    expect(mine.closeTerminal).not.toHaveBeenCalled();
    expect(await pluginEnv()).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: "/Applications/Desk.app/Contents/Resources/claude-plugin" });
  });
});
