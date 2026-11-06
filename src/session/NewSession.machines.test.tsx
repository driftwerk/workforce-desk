import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { EngineInfo } from "../hub/types";
import { useMachines } from "../machines/engines";
import { FOLDERS_DEBOUNCE_MS } from "../machines/FolderPicker";
import { fakeNative, foldersTransport, machine, noEngines, withEngine } from "../machines/testing";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { EMPTY_LAYOUT } from "../groups/model";
import { useHubLayout } from "../groups/store";
import { useSettings } from "../settings/store";
import { groupSays, NewSession } from "./NewSession";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  machineHome: vi.fn(async () => "/home/dev"),
  inApp: false,
  pickFolder: vi.fn(async () => null),
  claudePluginDir: vi.fn(async () => "/Applications/Desk.app/Contents/Resources/claude-plugin"),
  programsUnder: vi.fn(async () => []),
  saveSettings: vi.fn(async () => {}),
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
  // Home first, always; then what's there that starts as typed.
  expect(within(list).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["⌂~· home folder, /home/dev, always there›", "~/src/workforcegit›"]);
  fireEvent.click(within(list).getByRole("button", { name: /^~\/src\/workforce/ }));
  expect((folder as HTMLInputElement).value).toBe("~/src/workforce");

  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start in ~/src/workforce" })));
  expect(localStart).not.toHaveBeenCalled();
  // The machine's own path: its home in place of ~.
  expect(machineStart).toHaveBeenCalledWith(
    expect.objectContaining({
      engine: "claude",
      cwd: "/home/dev/src/workforce",
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

describe("its group", () => {
  const ACME = { id: "acme", name: "Acme", collapsed: false, items: ["session:s-1", "session:devbox/d1"] };
  const ATLAS = { id: "atlas", name: "Atlas", collapsed: false, items: [] };
  beforeEach(() => {
    useHubLayout.setState({ layout: null, kept: false });
    useSettings.setState({ loaded: true, groups: [ACME, ATLAS], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
  });
  const group = () => screen.getByRole("radiogroup", { name: "Group" });
  const chosen = () => within(group()).getAllByRole("radio").find((r) => r.getAttribute("aria-checked") === "true")?.textContent;

  it("is the group it was started from, else the open session's, else Ungrouped", () => {
    render(<NewSession group="atlas" onClose={() => {}} native={fakeNative().native} />);
    expect(within(group()).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Acme", "Atlas", "Ungrouped"]);
    expect(chosen()).toBe("Atlas");
    expect(screen.getByText("Atlas, where you started it.")).toBeTruthy();
    cleanup();
    useDesk.setState({ openId: "devbox/d1" });
    render(<NewSession onClose={() => {}} native={fakeNative().native} />);
    expect(chosen()).toBe("Acme");
    cleanup();
    useDesk.setState({ openId: null });
    render(<NewSession onClose={() => {}} native={fakeNative().native} />);
    expect(chosen()).toBe("Ungrouped");
  });

  it("a session started on a machine lands in the chosen group, with its machine's tag", async () => {
    const { native } = fakeNative({ transport: vi.fn(() => foldersTransport({ home: "/home/dev", folders: [] }, [])) });
    render(<NewSession group="acme" onClose={() => {}} native={native} />);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "devbox" })));
    expect(screen.getByText("Acme, where you started it. It shows in Acme with a devbox tag.")).toBeTruthy();
    fireEvent.click(within(group()).getByRole("radio", { name: "Atlas" }));
    expect(screen.getByText("It shows in Atlas with a devbox tag.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Folder on devbox"), { target: { value: "~/src/atlas" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start in ~/src/atlas" })));
    expect(useSettings.getState().groups[1]!.items).toEqual(["session:devbox/s-9"]);
  });

  it("one on this computer lands in its group too; Ungrouped takes one as it comes", async () => {
    render(<NewSession group="atlas" onClose={() => {}} native={fakeNative().native} />);
    fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/Users/me/atlas" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
    expect(useSettings.getState().groups[1]!.items).toEqual(["session:s-1"]);
    expect(groupSays("ungrouped", "acme", "Ungrouped", null)).toBe("It shows in Ungrouped.");
  });

  it("isn't asked with no groups", () => {
    useSettings.setState({ groups: [] });
    render(<NewSession onClose={() => {}} native={fakeNative().native} />);
    expect(screen.queryByRole("radiogroup", { name: "Group" })).toBeNull();
  });
});
