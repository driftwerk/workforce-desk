import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import type { Caps, EngineAccount, EngineInfo, View } from "../hub/types";
import { useDesk } from "../hub/store";
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

afterEach(cleanup);

it("starts a session with Desk's plugin folder, so Claude Code reports its plan's usage", async () => {
  const start = vi.fn(() => Promise.resolve({ id: "s-1" }));
  useDesk.setState({
    hub: { start, engines: vi.fn(async () => null) } as unknown as DeskHub,
    openId: null,
  });
  const onClose = vi.fn();
  render(<NewSession onClose={onClose} />);
  fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), {
    target: { value: "/work/atlas" },
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: "/work/atlas",
      name: "atlas",
      env: {
        CLAUDE_CODE_PLUGIN_DIRS: "/Applications/Desk.app/Contents/Resources/claude-plugin",
      },
    }),
  );
  expect(useDesk.getState().openId).toBe("s-1");
  expect(onClose).toHaveBeenCalled();
});

const engine = (e: Partial<EngineInfo> & Pick<EngineInfo, "engine" | "title">): EngineInfo => ({
  program: e.engine,
  installed: true,
  version: "1.0.0",
  signIn: { state: "unknown" },
  views: [],
  caps: {},
  ...e,
});

const terminalCaps = (approvals: Caps["approvals"], notes: string[] = []): Partial<Record<View, Caps>> => ({
  terminal: {
    state: "hooks",
    approvals,
    resume: "byId",
    interrupt: "keys",
    plan: null,
    notes,
  },
});

it("offers the engines the hub starts, and approvals in Desk only where the engine answers there", async () => {
  const start = vi.fn(() => Promise.resolve({ id: "s-2" }));
  const engines = vi.fn(async () => [
    engine({
      engine: "claude",
      title: "Claude Code",
      views: ["terminal"],
      caps: terminalCaps("desk"),
    }),
    engine({
      engine: "codex",
      title: "Codex",
      views: ["terminal"],
      caps: terminalCaps("terminal", ["Codex asks its approvals in its own terminal."]),
    }),
    engine({ engine: "gemini", title: "Gemini CLI" }),
    engine({
      engine: "devin",
      title: "Devin",
      installed: false,
      views: ["terminal"],
      caps: terminalCaps("none"),
    }),
  ]);
  useDesk.setState({
    hub: { start, engines } as unknown as DeskHub,
    openId: null,
  });
  render(<NewSession onClose={vi.fn()} />);
  await act(async () => {});
  const offered = screen.getAllByRole("radio", { name: /Code|Codex|Gemini|Devin/ }).map((b) => b.textContent);
  expect(offered).toEqual(["Claude Code", "Codex"]);
  expect(screen.getByRole("radiogroup", { name: "Approvals" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
  expect(screen.queryByRole("radiogroup", { name: "Approvals" })).toBeNull();
  expect(screen.getByText("Codex asks its approvals in its own terminal.")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), {
    target: { value: "/work/atlas" },
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex", approvals: undefined }));
});

it("starts Codex with Approve for me only when asked, and only where the hub offers it", async () => {
  const start = vi.fn(() => Promise.resolve({ id: "s-3" }));
  const caps = terminalCaps("terminal");
  const engines = vi.fn(async () => [
    engine({ engine: "claude", title: "Claude Code", views: ["terminal"], caps: terminalCaps("desk") }),
    engine({ engine: "codex", title: "Codex", views: ["terminal"], caps: { terminal: { ...caps.terminal!, approveForMe: true } } }),
  ]);
  useDesk.setState({ hub: { start, engines } as unknown as DeskHub, openId: null });
  render(<NewSession onClose={vi.fn()} />);
  await act(async () => {});
  expect(screen.queryByRole("radio", { name: "Approve for me" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
  expect(screen.getByRole("radio", { name: "Ask me" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "Approve for me" }));
  expect(screen.getByText(/Codex’s own reviewer answers what it asks/)).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/work/atlas" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex", approveForMe: true }));
});

const account = (id: string, name: string, isDefault = false): EngineAccount => ({
  id,
  engine: "claude",
  name,
  isDefault,
  signedIn: true,
  sessions: [],
  createdAt: "2026-11-03T09:00:00Z",
});

it("starts Claude Code on the default account, another the person picks, or this computer's sign-in", async () => {
  const start = vi.fn(() => Promise.resolve({ id: "s-4" }));
  const caps = terminalCaps("desk");
  const engines = vi.fn(async () => [
    engine({ engine: "claude", title: "Claude Code", views: ["terminal"], caps: { terminal: { ...caps.terminal!, accounts: "token" } } }),
    engine({ engine: "codex", title: "Codex", views: ["terminal"], caps: terminalCaps("terminal") }),
  ]);
  const accounts = vi.fn(async () => ({ accounts: [account("a-p", "Personal"), account("a-w", "Work", true)], store: "the keychain", signIns: [] }));
  useDesk.setState({ hub: { start, engines, accounts } as unknown as DeskHub, openId: null });
  render(<NewSession onClose={vi.fn()} />);
  await act(async () => {});
  const picker = screen.getByRole("radiogroup", { name: "Account" });
  expect([...picker.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Work", "Personal", "This computer’s sign-in"]);
  expect(screen.getByRole("radio", { name: "Work" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/work/atlas" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ engine: "claude", account: "a-w" }));
  fireEvent.click(screen.getByRole("radio", { name: "This computer’s sign-in" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ account: null }));
  // Codex runs on its own sign-in: no picker, nothing sent.
  fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
  expect(screen.queryByRole("radiogroup", { name: "Account" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ engine: "codex", account: undefined }));
});
