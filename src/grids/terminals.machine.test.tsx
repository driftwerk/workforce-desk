import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { TerminalInfo } from "../hub/types";
import { noEngines, withEngine } from "../machines/testing";
import type { PaneContent } from "./engine";
import { createGrid, newTerminal, useGrids } from "./store";
import { setMachineHome, useTerminalPane, useTerminals } from "./terminals";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  inApp: false,
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  claudePluginDir: vi.fn(async () => "/Applications/Desk.app/Contents/Resources/claude-plugin"),
  machinePluginDir: vi.fn(async () => "/home/dev/.local/share/Desk/bin/current/claude-plugin"),
  programsUnder: vi.fn(async () => []),
}));

const info = (id: string, cwd: string): TerminalInfo => ({
  id,
  name: "shell",
  cwd,
  envKeys: [],
  shell: "/bin/bash",
  state: "running",
  live: true,
  exitCode: null,
  createdAt: "t",
  updatedAt: "t",
});

const localOpen = vi.fn(async () => info("t-local", "/Users/me"));
const machineOpen = vi.fn(async (t: { id: string; cwd: string }) => info(t.id, t.cwd));

beforeEach(() => {
  localOpen.mockClear();
  machineOpen.mockClear();
  useDesk.setState({ hub: { openTerminal: localOpen } as unknown as DeskHub, sessions: {} });
  noEngines();
  useTerminals.setState({ byId: {} });
  setMachineHome(async (m) => (m === "devbox" ? "/home/dev" : null));
});
afterEach(cleanup);

/** The terminal pane `newTerminal` just made in grid `g`. */
const terminalPane = (g: string) => {
  const p = useGrids.getState().grids[g]!.panes.find((x) => x.content?.kind === "terminal")!;
  return { id: p.id, content: p.content as Extract<PaneContent, { kind: "terminal" }> };
};

it("opens a machine's new terminal on that machine's engine, in its home, never on this computer", async () => {
  withEngine("devbox", { openTerminal: machineOpen } as unknown as DeskHub);
  const g = createGrid();
  newTerminal(g, "devbox");
  const pane = terminalPane(g);
  expect(pane.content).toEqual({ kind: "terminal", terminalId: null, machine: "devbox" });

  renderHook(() => useTerminalPane(g, pane.id, terminalPane(g).content));
  await act(async () => {});

  expect(localOpen).not.toHaveBeenCalled();
  expect(machineOpen).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: "/home/dev", env: { CLAUDE_CODE_PLUGIN_DIRS: "/home/dev/.local/share/Desk/bin/current/claude-plugin" } }),
  );
  const opened = machineOpen.mock.calls[0]![0].id;
  // The pane keeps its machine with the terminal's id; the terminal is known by its machine's key.
  expect(terminalPane(g).content).toEqual({ kind: "terminal", terminalId: opened, cwd: "/home/dev", machine: "devbox" });
  expect(useTerminals.getState().byId[`devbox/${opened}`]).toMatchObject({ cwd: "/home/dev" });
});

it("opens nothing for a machine whose engine isn't connected, and never falls back to this computer", async () => {
  const g = createGrid();
  newTerminal(g, "devbox");
  const pane = terminalPane(g);
  renderHook(() => useTerminalPane(g, pane.id, pane.content));
  await act(async () => {});
  expect(localOpen).not.toHaveBeenCalled();
  expect(terminalPane(g).content.terminalId).toBeNull();
});

it("opens this computer's new terminal here, as before", async () => {
  withEngine("devbox", { openTerminal: machineOpen } as unknown as DeskHub);
  const g = createGrid();
  newTerminal(g);
  const pane = terminalPane(g);
  expect(pane.content).toEqual({ kind: "terminal", terminalId: null });
  renderHook(() => useTerminalPane(g, pane.id, pane.content));
  await act(async () => {});
  expect(localOpen).toHaveBeenCalled();
  expect(machineOpen).not.toHaveBeenCalled();
});
