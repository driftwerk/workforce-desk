import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallProgress } from "../platform";
import { PlanSignIn } from "../floor/PlanCards";

let push: (plan: "claude" | "chatgpt", p: InstallProgress) => void = () => {};

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  cancelLogin: vi.fn(),
  cliInstalled: vi.fn(async () => false),
  installCli: vi.fn(async () => undefined),
  onInstallProgress: vi.fn((f: typeof push) => {
    push = f;
    return Promise.resolve(() => {});
  }),
  onLoginProgress: vi.fn(),
  openUrl: vi.fn(),
  sendLoginCode: vi.fn(),
  startLogin: vi.fn(async () => undefined),
  subscribe: vi.fn(() => () => {}),
}));

const writeText = vi.fn(async (_: string) => undefined);

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => {
  cleanup();
  writeText.mockClear();
});

describe("a Claude Code install that stopped", () => {
  it("says why and offers the command to run by hand, with where", async () => {
    render(<PlanSignIn kind="claude" />);
    act(() =>
      push("claude", {
        state: "failed",
        message: "The download stalled. On a VPN, try with it off.",
        command: "curl -fsSL https://claude.ai/install.sh | bash",
        hint: "Run it in Ubuntu (WSL).",
      }),
    );
    expect(screen.getByRole("status").textContent).toContain("The download stalled. On a VPN, try with it off.");
    expect(screen.getByText("Run it in Ubuntu (WSL).")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("curl -fsSL https://claude.ai/install.sh | bash"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("shows no command when the installer gave none", () => {
    render(<PlanSignIn kind="claude" />);
    act(() => push("claude", { state: "failed", message: "Claude Code's installer stopped: Unsupported architecture" }));
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
  });

  it("says so when the clipboard won't take it", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<PlanSignIn kind="claude" />);
    act(() => push("claude", { state: "failed", message: "x", command: "curl -fsSL https://claude.ai/install.sh | bash" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(await screen.findByText("Couldn’t copy, select and copy it")).toBeTruthy();
  });
});
