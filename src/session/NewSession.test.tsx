import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import { NewSession } from "./NewSession";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
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
  useDesk.setState({ hub: { start } as unknown as DeskHub, openId: null });
  const onClose = vi.fn();
  render(<NewSession onClose={onClose} />);
  fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/work/atlas" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: "/work/atlas",
      name: "atlas",
      env: { CLAUDE_CODE_PLUGIN_DIRS: "/Applications/Desk.app/Contents/Resources/claude-plugin" },
    }),
  );
  expect(useDesk.getState().openId).toBe("s-1");
  expect(onClose).toHaveBeenCalled();
});
