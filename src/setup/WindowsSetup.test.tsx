import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WslDetection, WslFound } from "../platform";

const platform = vi.hoisted(() => ({
  detectWsl: vi.fn(),
  installWsl: vi.fn(),
  setUpInWsl: vi.fn(),
  convertToWsl2: vi.fn(),
  fixWslForwarding: vi.fn(),
}));
vi.mock("../platform", async (real) => ({
  ...(await real<typeof import("../platform")>()),
  ...platform,
  onWslSetup: vi.fn(() => Promise.resolve(() => {})),
  openUrl: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

const { WindowsSetup } = await import("./WindowsSetup");
const { LocalSetupCard } = await import("./LocalSetupCard");
const { useSetup } = await import("./store");
const { DEFAULT_HOST, useHost } = await import("../shell/host");
const { LOOK_AGAIN_MS } = await import("./wsl");

const probe = { arch: "x86_64", kernel: "6.6.36.6-microsoft-standard-WSL2", user: "sarah", home: "/home/sarah", automount: "/mnt/", glibc: "2.39" };
const ubuntu: WslFound = { distro: { name: "Ubuntu", state: "Running", version: 2, default: true }, probe, problem: null };
const debian: WslFound = { distro: { name: "Debian", state: "Stopped", version: 2, default: false }, probe, problem: null };
const none: WslDetection = { problem: { kind: "not_installed" }, distros: [] };

const flush = () => act(async () => {});
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  platform.detectWsl.mockReset().mockResolvedValue(none);
  platform.installWsl.mockReset().mockResolvedValue(undefined);
  platform.setUpInWsl.mockReset().mockResolvedValue(undefined);
  useSetup.setState({ open: true, skipped: false });
  useHost.setState({ ...DEFAULT_HOST, platform: "windows", host: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Windows' setup carries on by itself", () => {
  it("says Desk opens again after the restart, and has no 'look again' chore", async () => {
    render(<WindowsSetup />);
    await flush();
    expect(screen.getByText(/Desk opens by itself after the restart and carries on here/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /look again/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install WSL and Ubuntu" }));
    await flush();
    expect(platform.installWsl).toHaveBeenCalledTimes(1);
  });

  it("looks for WSL again by itself, and sets up in the only Linux there is without asking", async () => {
    render(<WindowsSetup />);
    await flush();
    expect(platform.detectWsl).toHaveBeenCalledTimes(1);
    platform.detectWsl.mockResolvedValue({ problem: null, distros: [ubuntu] });
    await tick(LOOK_AGAIN_MS + 10);
    expect(platform.detectWsl).toHaveBeenCalledTimes(2);
    expect(platform.setUpInWsl).toHaveBeenCalledWith("Ubuntu");
    expect(screen.getByText("Setting up Desk in Ubuntu")).toBeTruthy();
  });

  it("looks again when Desk comes forward", async () => {
    render(<WindowsSetup />);
    await flush();
    act(() => void window.dispatchEvent(new Event("focus")));
    await flush();
    expect(platform.detectWsl).toHaveBeenCalledTimes(2);
  });

  it("still asks which Linux when there are two", async () => {
    platform.detectWsl.mockResolvedValue({ problem: null, distros: [ubuntu, debian] });
    render(<WindowsSetup />);
    await flush();
    expect(screen.getByText("Which Linux should Desk use?")).toBeTruthy();
    expect(platform.setUpInWsl).not.toHaveBeenCalled();
  });

  it("says a failed install plainly, with a way to try again", async () => {
    platform.installWsl.mockRejectedValue(
      "WSL didn't install: Windows needs an administrator's OK for it. Try again, and choose Yes when Windows asks.",
    );
    render(<WindowsSetup />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Install WSL and Ubuntu" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(/Windows needs an administrator's OK/);
    expect((screen.getByRole("button", { name: "Install WSL and Ubuntu" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(platform.installWsl).toHaveBeenCalledTimes(2);
  });
});

describe("Not now", () => {
  it("leaves a Floor card to set local agents up later", async () => {
    render(
      <>
        <WindowsSetup />
        <LocalSetupCard />
      </>,
    );
    await flush();
    expect(screen.queryByRole("region", { name: "Set up local agents" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Not now/ }));
    expect(useSetup.getState()).toMatchObject({ open: false, skipped: true });
    expect(screen.getByRole("region", { name: "Set up local agents" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set it up" }));
    expect(useSetup.getState()).toMatchObject({ open: true, skipped: false });
  });

  it("isn't offered once Desk runs in WSL", () => {
    useSetup.setState({ skipped: true });
    useHost.setState({ ...DEFAULT_HOST, platform: "windows", host: { kind: "wsl" } as never });
    render(<LocalSetupCard />);
    expect(screen.queryByRole("region", { name: "Set up local agents" })).toBeNull();
  });
});
