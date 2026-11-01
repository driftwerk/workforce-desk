import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import type { Caps, EngineInfo, View } from "../hub/types";
import { useDesk } from "../hub/store";
import { NewSession } from "./NewSession";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
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
