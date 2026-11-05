import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { EngineInfo } from "../hub/types";
import { useMachines } from "../machines/engines";
import { FOLDERS_DEBOUNCE_MS } from "../machines/RunOn";
import { fakeNative, foldersTransport, machine, noEngines, withEngine } from "../machines/testing";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { NewSession } from "./NewSession";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  inApp: false,
  pickFolder: vi.fn(async () => null),
  claudePluginDir: vi.fn(async () => "/Applications/Desk.app/Contents/Resources/claude-plugin"),
  programsUnder: vi.fn(async () => []),
}));

const engine = (e: Partial<EngineInfo> & Pick<EngineInfo, "engine" | "title">): EngineInfo => ({
  program: e.engine,
  installed: true,
  version: "1.0.0",
  signIn: { state: "unknown" },
  views: ["terminal"],
  caps: {},
  ...e,
});

const localStart = vi.fn(async () => ({ id: "s-1" }));
const machineStart = vi.fn(async () => ({ id: "s-9" }));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStart.mockClear();
  machineStart.mockClear();
  useHost.setState(DEFAULT_HOST);
  useDesk.setState({ hub: { start: localStart, engines: vi.fn(async () => null) } as unknown as DeskHub, openId: null });
  noEngines();
  withEngine(
    "devbox",
    {
      start: machineStart,
      engines: vi.fn(async () => [engine({ engine: "claude", title: "Claude Code" }), engine({ engine: "codex", title: "Codex", installed: false, views: [] })]),
    } as unknown as DeskHub,
  );
  useMachines.setState({ listed: true, machines: [machine({ id: "devbox" }), machine({ id: "buildbox", state: { kind: "unreachable" } })] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("offers Run on once there's a machine, and an offline one can't be chosen", () => {
  render(<NewSession onClose={() => {}} native={fakeNative().native} />);
  const mac = screen.getByRole("radio", { name: "This Mac" });
  expect(mac.getAttribute("aria-checked")).toBe("true");
  const off = screen.getByRole("radio", { name: "buildbox · offline" });
  expect(off.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(off);
  expect(mac.getAttribute("aria-checked")).toBe("true");
  // On this computer, the folder is picked as before.
  expect(screen.getByRole("button", { name: "Choose…" })).toBeTruthy();
});

it("hides Run on with no machines", () => {
  useMachines.setState({ machines: [] });
  render(<NewSession onClose={() => {}} native={fakeNative().native} />);
  expect(screen.queryByRole("radiogroup", { name: "Run on" })).toBeNull();
});

it("starts a session on a machine: its folder typed with suggestions from there, its engines, its plugin folder", async () => {
  const seen: string[] = [];
  const { native, fake } = fakeNative({
    transport: vi.fn(() => foldersTransport({ home: "/home/dev", folders: [{ path: "/home/dev/src/workforce", git: true }, { path: "/home/dev/src/notes" }] }, seen)),
  });
  const onClose = vi.fn();
  render(<NewSession onClose={onClose} native={native} />);
  await act(async () => fireEvent.click(screen.getByRole("radio", { name: "devbox" })));

  expect(screen.queryByRole("button", { name: "Choose…" })).toBeNull();
  const folder = screen.getByLabelText("Folder on devbox");
  // Its engines: Codex isn't there.
  expect(screen.getByText("Codex isn’t installed on devbox.")).toBeTruthy();
  expect(screen.queryByRole("radio", { name: "Codex" })).toBeNull();

  fireEvent.change(folder, { target: { value: "~/src/wo" } });
  await act(async () => vi.advanceTimersByTime(FOLDERS_DEBOUNCE_MS));
  expect(fake.transport).toHaveBeenCalledWith("devbox");
  expect(seen.at(-1)).toBe("/api/desk/folders?path=%7E%2Fsrc");
  const list = screen.getByRole("list", { name: "Folders on devbox" });
  expect(list.textContent).toBe("~/src/workforce git");
  fireEvent.click(within(list).getAllByRole("button")[0]!);
  expect((folder as HTMLInputElement).value).toBe("~/src/workforce");

  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start on devbox" })));
  expect(localStart).not.toHaveBeenCalled();
  expect(machineStart).toHaveBeenCalledWith(
    expect.objectContaining({
      engine: "claude",
      cwd: "~/src/workforce",
      name: "workforce",
      env: { CLAUDE_CODE_PLUGIN_DIRS: "/home/dev/.local/share/Desk/bin/current/claude-plugin" },
    }),
  );
  expect(fake.pluginDir).toHaveBeenCalledWith("devbox");
  expect(useDesk.getState().openId).toBe("devbox/s-9");
  expect(onClose).toHaveBeenCalled();
});

it("forgets a folder typed for another computer when Run on changes", async () => {
  render(<NewSession onClose={() => {}} native={fakeNative().native} />);
  fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/Users/me/work" } });
  await act(async () => fireEvent.click(screen.getByRole("radio", { name: "devbox" })));
  expect((screen.getByLabelText("Folder on devbox") as HTMLInputElement).value).toBe("");
});
