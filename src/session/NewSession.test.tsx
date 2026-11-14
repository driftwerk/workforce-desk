import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import type { Caps, EngineAccount, EngineInfo, View } from "../hub/types";
import { useDesk } from "../hub/store";
import { installCli } from "../platform";
import { NewSession, noneOf, whyNotStart } from "./NewSession";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  inApp: false,
  pickFolder: vi.fn(async () => null),
  claudePluginDir: vi.fn(async () => "/Applications/Desk.app/Contents/Resources/claude-plugin"),
  programsUnder: vi.fn(async () => []),
  installCli: vi.fn(async () => {}),
  onInstallProgress: vi.fn(async () => () => {}),
  subscribe: (p: Promise<() => void>) => () => void p.then((f) => f()),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("starts a session with Desk's plugin folder, so Claude Code reports its plan's usage", async () => {
  const start = vi.fn(() => Promise.resolve({ id: "s-1" }));
  useDesk.setState({
    hub: { start, engines: vi.fn(async () => null) } as unknown as DeskHub,
    openId: null,
  });
  const onClose = vi.fn();
  render(<NewSession onClose={onClose} />);
  fireEvent.change(screen.getByLabelText("Folder"), {
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
  fireEvent.change(screen.getByLabelText("Folder"), {
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
  fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/work/atlas" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex", approveForMe: true }));
});

it("starts Codex in Fast mode only when asked, saying it uses the plan sooner, and only where the hub offers it", async () => {
  const start = vi.fn(() => Promise.resolve({ id: "s-4" }));
  const caps = terminalCaps("terminal");
  const engines = vi.fn(async () => [
    engine({ engine: "claude", title: "Claude Code", views: ["terminal"], caps: terminalCaps("desk") }),
    engine({ engine: "codex", title: "Codex", views: ["terminal"], caps: { terminal: { ...caps.terminal!, fast: true } } }),
  ]);
  useDesk.setState({ hub: { start, engines } as unknown as DeskHub, openId: null });
  render(<NewSession onClose={vi.fn()} />);
  await act(async () => {});
  expect(screen.queryByRole("radio", { name: "Fast" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
  expect(screen.getByRole("radio", { name: "Standard" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByText(/uses up your plan’s limits sooner/)).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
  expect(screen.getByText(/uses up your plan’s limits sooner/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/work/atlas" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex", fast: true }));
});

it("starts Codex at the usual speed unless Fast is chosen", async () => {
  const start = vi.fn(() => Promise.resolve({ id: "s-5" }));
  const caps = terminalCaps("terminal");
  const engines = vi.fn(async () => [engine({ engine: "codex", title: "Codex", views: ["terminal"], caps: { terminal: { ...caps.terminal!, fast: true } } })]);
  useDesk.setState({ hub: { start, engines } as unknown as DeskHub, openId: null });
  render(<NewSession onClose={vi.fn()} />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/work/atlas" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex", fast: undefined }));
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
  fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/work/atlas" } });
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

/** Devin as the hub sends it: a terminal engine on hooks, approvals in
 *  Desk, no Approve for me or Fast, and its card's notes. */
const DEVIN_NOTES = ["The first time in a folder, Devin asks in its terminal whether to trust it.", "Messages from Desk are typed in when Devin is idle."];
const devinEngine = (over: Partial<EngineInfo> = {}): EngineInfo =>
  engine({
    engine: "devin",
    title: "Devin",
    program: "/Users/x/.local/bin/devin",
    version: "3000.12.57",
    signIn: { state: "in", via: "vendor", who: "sam@example.com", plan: null },
    views: ["terminal"],
    caps: { terminal: { ...terminalCaps("desk", DEVIN_NOTES).terminal!, approveForMe: false, fast: false, accounts: "none", line: "paste", steer: "none" } },
    ...over,
  });

it("starts Devin like its siblings: approvals in Desk, its notes, and no Approve for me or Speed", async () => {
  const start = vi.fn(() => Promise.resolve({ id: "s-dv" }));
  const engines = vi.fn(async () => [
    engine({ engine: "claude", title: "Claude Code", views: ["terminal"], caps: terminalCaps("desk") }),
    engine({ engine: "codex", title: "Codex", views: ["terminal"], caps: { terminal: { ...terminalCaps("terminal").terminal!, approveForMe: true, fast: true } } }),
    devinEngine(),
  ]);
  useDesk.setState({ hub: { start, engines } as unknown as DeskHub, openId: null });
  render(<NewSession onClose={vi.fn()} />);
  await act(async () => {});
  expect(screen.getAllByRole("radio", { name: /Code|Codex|Devin/ }).map((b) => b.textContent)).toEqual(["Claude Code", "Codex", "Devin"]);
  fireEvent.click(screen.getByRole("radio", { name: "Devin" }));
  for (const n of DEVIN_NOTES) expect(screen.getByText(n)).toBeTruthy();
  const approvals = screen.getAllByRole("radiogroup", { name: "Approvals" });
  expect(approvals).toHaveLength(1);
  expect(approvals[0]!.textContent).toBe("In DeskIn the terminal");
  expect(screen.queryByRole("radio", { name: "Approve for me" })).toBeNull();
  expect(screen.queryByRole("radiogroup", { name: "Speed" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/work/atlas" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ engine: "devin", approvals: "desk", approveForMe: undefined, fast: undefined }));
});

it("doesn't offer a Devin the hub can't start, or one that isn't installed", async () => {
  const engines = vi.fn(async () => [engine({ engine: "claude", title: "Claude Code", views: ["terminal"], caps: terminalCaps("desk") }), devinEngine({ views: [] })]);
  useDesk.setState({ hub: { start: vi.fn(), engines } as unknown as DeskHub, openId: null });
  render(<NewSession onClose={vi.fn()} />);
  await act(async () => {});
  expect(screen.queryByRole("radio", { name: "Devin" })).toBeNull();
});

it("says Devin isn't signed in, and signs it in to Devin in place", async () => {
  const startEngineSignIn = vi.fn(async () => ({ id: "dv-1", engine: "devin", state: "starting" }));
  const engines = vi.fn(async () => [devinEngine({ signIn: { state: "out" } })]);
  useDesk.setState({ hub: { start: vi.fn(), engines, startEngineSignIn, engineSignIn: startEngineSignIn, cancelEngineSignIn: vi.fn(async () => {}) } as unknown as DeskHub, openId: null });
  render(<NewSession onClose={vi.fn()} />);
  await act(async () => {});
  const fix = screen.getByRole("group", { name: "Devin isn’t signed in" });
  expect(fix.textContent).toContain("a session would stop at its sign-in");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to Devin…" })));
  expect(startEngineSignIn).toHaveBeenCalledWith("devin");
  expect(screen.getByText("Opening Devin’s sign-in page…")).toBeTruthy();
});

it("offers Install for Devin beside Claude Code and Codex when nothing is installed", async () => {
  const engines = vi.fn(async () => [
    engine({ engine: "claude", title: "Claude Code", installed: false, views: ["terminal"] }),
    engine({ engine: "codex", title: "Codex", installed: false, views: ["terminal"] }),
    devinEngine({ installed: false }),
  ]);
  useDesk.setState({ hub: { start: vi.fn(), engines } as unknown as DeskHub, openId: null });
  render(<NewSession onClose={vi.fn()} />);
  await act(async () => {});
  const fix = screen.getByRole("group", { name: "Nothing to start a session with" });
  expect(fix.textContent).toMatch(/None of Claude Code, Codex or Devin is installed on /);
  expect(Array.from(fix.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Install Claude Code", "Install Codex", "Install Devin"]);
  expect(screen.getByText("Install Claude Code, Codex or Devin above, then start.")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Install Devin" })));
  expect(installCli).toHaveBeenCalledWith("devin");
});

it("names what isn't installed in plain words", () => {
  expect(noneOf(["Devin"])).toBe("Devin isn’t");
  expect(noneOf(["Claude Code", "Codex"])).toBe("Neither Claude Code nor Codex is");
  expect(whyNotStart({ hub: true, folder: "", remote: false, where: "", noFolder: false, cantSignIn: null, starting: false, noEngine: true })?.words).toBe(
    "Install Claude Code or Codex above, then start.",
  );
});
