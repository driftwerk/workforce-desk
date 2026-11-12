import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WslDetection, WslFound } from "../platform";

const platform = vi.hoisted(() => ({
  detectWsl: vi.fn(),
  installWsl: vi.fn(),
  setUpInWsl: vi.fn(),
  convertToWsl2: vi.fn(),
  createWslUser: vi.fn(),
  installUbuntuAlongside: vi.fn(),
  wslUserName: vi.fn(),
  fixWslForwarding: vi.fn(),
  forgetWslResume: vi.fn(),
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
const { LOOK_AGAIN_MS, START_SOON_MS } = await import("./wsl");

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
  platform.forgetWslResume.mockReset().mockResolvedValue(undefined);
  platform.convertToWsl2.mockReset().mockResolvedValue(undefined);
  platform.createWslUser.mockReset().mockResolvedValue("sarah");
  platform.installUbuntuAlongside.mockReset().mockResolvedValue("Ubuntu-24.04");
  platform.wslUserName.mockReset().mockResolvedValue("sarah");
  useSetup.setState({ open: true, skipped: false });
  useHost.setState({ ...DEFAULT_HOST, platform: "windows", host: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Linux Desk can't use yet, put right by Desk", () => {
  const rooted: WslFound = { ...debian, distro: { ...debian.distro, default: true }, probe: { ...probe, user: "root" }, problem: { kind: "root_user", distro: "Debian" } };
  const ancient: WslFound = { ...ubuntu, probe: { ...probe, glibc: "2.31" }, problem: { kind: "old_linux", glibc: "2.31" } };
  const wsl1: WslFound = { distro: { name: "Ubuntu-20.04", state: "Stopped", version: 1, default: true }, probe: null, problem: { kind: "wsl1", distro: "Ubuntu-20.04" } };

  it("makes a user in a Linux whose only one is root, then sets up there", async () => {
    platform.detectWsl.mockResolvedValue({ problem: null, distros: [rooted] });
    render(<WindowsSetup />);
    await flush();
    // Nothing set up by itself: the button is the one yes.
    expect(platform.setUpInWsl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create a user, then set up" }));
    await flush();
    // Said in full first: the user, its sudo, and that Debian restarts.
    const ask = screen.getByRole("group", { name: "Before Desk changes your Linux" });
    expect(ask.textContent).toContain("Desk makes the user sarah in Debian, who can use sudo without a password");
    expect(ask.textContent).toContain("Debian then restarts: anything running in it stops.");
    expect(platform.createWslUser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create sarah and restart Debian" }));
    await flush();
    expect(platform.createWslUser).toHaveBeenCalledWith("Debian");
    expect(platform.setUpInWsl).toHaveBeenCalledWith("Debian");
  });

  it("installs Ubuntu alongside a Linux too old for Desk, then sets up there", async () => {
    platform.detectWsl.mockResolvedValue({ problem: null, distros: [ancient] });
    render(<WindowsSetup />);
    await flush();
    expect(screen.getByText(/Too old for Desk/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install Ubuntu alongside" }));
    await flush();
    expect(screen.getByRole("group", { name: "Before Desk changes your Linux" }).textContent).toContain("makes you the user sarah there");
    fireEvent.click(screen.getByRole("button", { name: "Install Ubuntu 24.04" }));
    await flush();
    expect(platform.installUbuntuAlongside).toHaveBeenCalledTimes(1);
    expect(platform.setUpInWsl).toHaveBeenCalledWith("Ubuntu-24.04");
  });

  it("moves a WSL 1 Linux to WSL 2, and says a failure without WSL's own words", async () => {
    platform.detectWsl.mockResolvedValue({ problem: null, distros: [wsl1] });
    platform.convertToWsl2.mockRejectedValueOnce(new Error("Ubuntu-20.04 didn't move to WSL 2. Try again; Settings → Help can save a report."));
    render(<WindowsSetup />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Convert to WSL 2, then set up" }));
    await flush();
    expect(screen.getByRole("group", { name: "Before Desk changes your Linux" }).textContent).toContain("anything running in Ubuntu-20.04 stops");
    fireEvent.click(screen.getByRole("button", { name: "Move Ubuntu-20.04 to WSL 2" }));
    await flush();
    expect(platform.convertToWsl2).toHaveBeenCalledWith("Ubuntu-20.04");
    expect(platform.setUpInWsl).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Ubuntu-20.04 didn't move to WSL 2");
    fireEvent.click(screen.getByRole("button", { name: "Convert to WSL 2, then set up" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Move Ubuntu-20.04 to WSL 2" }));
    await flush();
    expect(platform.setUpInWsl).toHaveBeenCalledWith("Ubuntu-20.04");
  });
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
    // A moment to say no first.
    expect(screen.getByText("Setting up Desk in Ubuntu…")).toBeTruthy();
    expect(platform.setUpInWsl).not.toHaveBeenCalled();
    await tick(START_SOON_MS + 10);
    expect(platform.setUpInWsl).toHaveBeenCalledWith("Ubuntu");
    expect(screen.getByText("Setting up Desk in Ubuntu")).toBeTruthy();
  });

  it("lets the person cancel setting up in the only Linux, and then asks", async () => {
    platform.detectWsl.mockResolvedValue({ problem: null, distros: [ubuntu] });
    render(<WindowsSetup />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await tick(START_SOON_MS + 10);
    expect(platform.setUpInWsl).not.toHaveBeenCalled();
    expect(screen.getByText("Which Linux should Desk use?")).toBeTruthy();
  });

  it("ignores a look for WSL that comes back after setup has begun", async () => {
    let answer: (d: WslDetection) => void = () => {};
    render(<WindowsSetup />);
    await flush();
    // A look starts, and is slow.
    platform.detectWsl.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    await tick(LOOK_AGAIN_MS + 10);
    // Meanwhile the person installs another way and Desk moves on.
    platform.detectWsl.mockResolvedValue({ problem: null, distros: [ubuntu, debian] });
    act(() => void window.dispatchEvent(new Event("focus")));
    await flush();
    expect(screen.getByText("Which Linux should Desk use?")).toBeTruthy();
    // The slow look's answer comes back late: it changes nothing.
    await act(async () => answer(none));
    expect(screen.getByText("Which Linux should Desk use?")).toBeTruthy();
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
    expect(platform.forgetWslResume).toHaveBeenCalled();
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
