import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelLogin, openUrl, sendLoginCode, type InstallProgress, type LoginProgress } from "../platform";
import { PlanSignIn } from "../floor/PlanCards";

let push: (plan: "claude" | "chatgpt", p: InstallProgress) => void = () => {};
let progress: (plan: "claude" | "chatgpt", p: LoginProgress) => void = () => {};

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  cancelLogin: vi.fn(async () => undefined),
  cliInstalled: vi.fn(async () => false),
  installCli: vi.fn(async () => undefined),
  onInstallProgress: vi.fn((f: typeof push) => {
    push = f;
    return Promise.resolve(() => {});
  }),
  onLoginProgress: vi.fn((f: typeof progress) => {
    progress = f;
    return Promise.resolve(() => {});
  }),
  openUrl: vi.fn(),
  sendLoginCode: vi.fn(async () => undefined),
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

  it("keeps what the installer printed under Details, never in the sentence", () => {
    render(<PlanSignIn kind="claude" />);
    act(() =>
      push("claude", { state: "failed", message: "Claude Code's installer stopped before it finished.", details: "Unsupported architecture" }),
    );
    expect(screen.getByRole("status").textContent).toContain("Claude Code's installer stopped before it finished.");
    const details = screen.getByText("Details").closest("details")!;
    expect(details.textContent).toContain("Unsupported architecture");
    expect(details.open).toBe(false);
  });

  it("says so when the clipboard won't take it", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<PlanSignIn kind="claude" />);
    act(() => push("claude", { state: "failed", message: "x", command: "curl -fsSL https://claude.ai/install.sh | bash" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(await screen.findByText("Couldn’t copy, select and copy it")).toBeTruthy();
  });
});

describe("a Claude sign-in waiting on its page", () => {
  const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=x";

  it("shows the page's address to copy, keeps it while asking for the code, and Cancel ends it", async () => {
    render(<PlanSignIn kind="claude" />);
    act(() => progress("claude", { state: "starting" }));
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();

    act(() => progress("claude", { state: "browser", url: URL }));
    expect(screen.getByText(URL)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open it again" }));
    expect(openUrl).toHaveBeenCalledWith(URL);

    act(() => progress("claude", { state: "needs-code" }));
    expect(screen.getByText(URL)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("If the page shows a code, paste it here.");
    fireEvent.change(screen.getByLabelText("Code from the sign-in page"), { target: { value: " abc#123 " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sendLoginCode).toHaveBeenCalledWith("claude", " abc#123 ");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelLogin).toHaveBeenCalledWith("claude");
    await waitFor(() => expect(screen.queryByText(URL)).toBeNull());
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
  });

  it("keeps a typed code no longer than the sign-in", () => {
    render(<PlanSignIn kind="claude" />);
    act(() => progress("claude", { state: "needs-code" }));
    fireEvent.change(screen.getByLabelText("Code from the sign-in page"), { target: { value: "abc#123" } });
    act(() => progress("claude", { state: "failed", message: "Claude sign-in ended without a token." }));
    act(() => progress("claude", { state: "needs-code" }));
    expect((screen.getByLabelText("Code from the sign-in page") as HTMLInputElement).value).toBe("");
  });

  it("drops the address once the sign-in is over", () => {
    render(<PlanSignIn kind="claude" />);
    act(() => progress("claude", { state: "browser", url: URL }));
    act(() => progress("claude", { state: "failed", message: "Claude sign-in ended without a token." }));
    expect(screen.queryByText(URL)).toBeNull();
  });
});
