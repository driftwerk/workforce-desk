import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOST, useHost } from "../shell/host";
import type { HelperStatus } from "../platform";
import {
  DeskReadyBanner,
  FIRST_WAIT_MS,
  GRACE_MS,
  readyWords,
  RESTART_AFTER_MS,
  SHOW_AFTER_MS,
  START_WAIT_MS,
  useDeskReady,
  type Readiness,
} from "./DeskReady";
import { useDesk } from "./store";

const platform = vi.hoisted(() => ({
  startHelper: vi.fn(),
  helperStatus: vi.fn(),
  helperProgress: vi.fn(),
  helperLastReason: vi.fn(),
  openLoginItems: vi.fn(),
  moveToApplications: vi.fn(),
}));
vi.mock("../platform", () => platform);

/** The banner as App wires it. */
function Wired() {
  const { readiness, retry } = useDeskReady();
  return (
    <div data-hub-down={readiness.kind !== "ready" || undefined} data-testid="app">
      <DeskReadyBanner readiness={readiness} onRetry={retry} />
    </div>
  );
}

const flush = () => act(async () => {});
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const banner = () => screen.queryByRole("status");

beforeEach(() => {
  vi.useFakeTimers();
  platform.startHelper.mockReset().mockResolvedValue({ state: "running" });
  platform.helperStatus.mockReset().mockResolvedValue({ state: "running" });
  platform.helperProgress.mockReset().mockResolvedValue("database");
  platform.helperLastReason.mockReset().mockResolvedValue("Postgres failed: port 5433 is busy");
  platform.openLoginItems.mockReset();
  platform.moveToApplications.mockReset().mockResolvedValue(undefined);
  useHost.setState(DEFAULT_HOST);
  useDesk.setState({ connected: false, answered: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Desk getting ready", () => {
  it("says it's getting ready with how far it has got, never that something isn't running", async () => {
    render(<Wired />);
    await tick(SHOW_AFTER_MS - 200);
    expect(banner()).toBeNull();
    await tick(400);
    expect(screen.getByText("Getting Desk ready…")).toBeTruthy();
    expect(screen.getByText(/Opening Desk’s database · step 2 of 4/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("38");
    expect(banner()!.textContent).not.toMatch(/hub|isn’t running/i);
    expect(screen.queryByRole("button")).toBeNull();
    act(() => useDesk.setState({ connected: true, answered: true }));
    await flush();
    expect(banner()).toBeNull();
    expect(screen.getByTestId("app").getAttribute("data-hub-down")).toBeNull();
  });

  it("follows the helper's steps as it goes", async () => {
    platform.helperProgress.mockResolvedValue(null);
    render(<Wired />);
    await tick(SHOW_AFTER_MS + 100);
    expect(screen.getByText("Starting Desk’s helper")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
    platform.helperProgress.mockResolvedValue("connecting");
    await tick(1_100);
    expect(screen.getByText(/Connecting · step 4 of 4/)).toBeTruthy();
  });

  it("starts the helper itself when the first start takes far too long", async () => {
    render(<Wired />);
    await tick(FIRST_WAIT_MS - 1_000);
    expect(platform.startHelper).not.toHaveBeenCalled();
    await tick(1_100);
    expect(platform.startHelper).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Getting Desk ready…")).toBeTruthy();
  });
});

it("keeps getting ready while a slow first start is still moving", async () => {
  const steps = ["starting", "database", "services", "connecting"] as const;
  let at = 0;
  platform.helperProgress.mockImplementation(async () => steps[Math.min(at, 3)]);
  render(<Wired />);
  await tick(FIRST_WAIT_MS + 100);
  expect(platform.startHelper).toHaveBeenCalledTimes(1);
  // A step further every wait: never "stopped".
  for (const _ of [1, 2, 3]) {
    at += 1;
    await tick(START_WAIT_MS);
    expect(screen.queryByText(/stopped and didn’t start again/)).toBeNull();
  }
  expect(screen.getByText("Getting Desk ready…")).toBeTruthy();
  // Then nothing moves for a whole wait: now it says so.
  await tick(START_WAIT_MS * 2);
  expect(screen.getByText("Desk’s helper stopped and didn’t start again")).toBeTruthy();
});

describe("Desk's helper stops", () => {
  beforeEach(() => useDesk.setState({ connected: true, answered: true }));

  it("waits quietly, then starts it again by itself, and says nothing if it comes back", async () => {
    render(<Wired />);
    act(() => useDesk.setState({ connected: false }));
    await tick(GRACE_MS - 500);
    expect(banner()).toBeNull();
    await tick(RESTART_AFTER_MS - GRACE_MS + 600);
    expect(platform.startHelper).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Getting Desk ready…")).toBeTruthy();
    expect(screen.getByTestId("app").getAttribute("data-hub-down")).toBe("true");
    act(() => useDesk.setState({ connected: true }));
    await flush();
    expect(banner()).toBeNull();
  });

  it("says so in plain words only when starting it again didn't work, and can try again", async () => {
    render(<Wired />);
    act(() => useDesk.setState({ connected: false }));
    await tick(RESTART_AFTER_MS + 100);
    await tick(START_WAIT_MS + 100);
    expect(screen.getByText("Desk’s helper stopped and didn’t start again")).toBeTruthy();
    expect(screen.getByText("Postgres failed: port 5433 is busy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await tick(10);
    expect(platform.startHelper).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Getting Desk ready…")).toBeTruthy();
  });

  it("says plainly when the start itself failed", async () => {
    platform.startHelper.mockResolvedValue({ state: "failed", message: "launchctl: Bootstrap failed: 5" });
    render(<Wired />);
    act(() => useDesk.setState({ connected: false }));
    await tick(RESTART_AFTER_MS + 100);
    expect(screen.getByText("Desk couldn’t start its helper")).toBeTruthy();
    expect(screen.getByText("launchctl: Bootstrap failed: 5")).toBeTruthy();
  });

  it("is not shown on Windows before Desk is set up there", async () => {
    useHost.setState({ ...DEFAULT_HOST, platform: "windows", host: null });
    render(<Wired />);
    act(() => useDesk.setState({ connected: false }));
    await tick(RESTART_AFTER_MS + 100);
    expect(banner()).toBeNull();
    expect(platform.startHelper).not.toHaveBeenCalled();
  });
});

describe("what the person has to do", () => {
  it("opens Login Items, and carries on by itself once Desk is turned on there", async () => {
    platform.helperStatus.mockResolvedValue({ state: "needs-approval" });
    render(<Wired />);
    await tick(SHOW_AFTER_MS + 100);
    expect(screen.getByText("Desk needs your OK to run in the background")).toBeTruthy();
    expect(screen.queryByText(/open Desk again|reopen/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Login Items" }));
    expect(platform.openLoginItems).toHaveBeenCalled();
    // Turned on; Desk comes forward.
    platform.helperStatus.mockResolvedValue({ state: "running" });
    act(() => void window.dispatchEvent(new Event("focus")));
    await flush();
    expect(platform.startHelper).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Getting Desk ready…")).toBeTruthy();
  });

  it("moves Desk for the person, and says why if it couldn't", async () => {
    platform.helperStatus.mockResolvedValue({ state: "move-to-applications" });
    platform.moveToApplications.mockRejectedValue("Desk couldn't copy itself to your Applications folder");
    render(<Wired />);
    await tick(SHOW_AFTER_MS + 100);
    fireEvent.click(screen.getByRole("button", { name: "Move it for me" }));
    await flush();
    expect(platform.moveToApplications).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Desk couldn't copy itself to your Applications folder")).toBeTruthy();
  });
});

describe("the words", () => {
  const all: Readiness[] = [
    { kind: "getting-ready", stage: null, first: true },
    { kind: "getting-ready", stage: "services", first: false },
    { kind: "stuck", reason: null },
    ...(
      [
        { state: "needs-approval" },
        { state: "move-to-applications" },
        { state: "development" },
        { state: "no-wsl", problem: { kind: "no_distro" } },
        { state: "port-unreachable" },
        { state: "failed", message: "x" },
      ] as HelperStatus[]
    ).map((status) => ({ kind: "blocked", status }) as Readiness),
  ];

  it("never call Desk's own helper a hub", () => {
    for (const platform of ["macos", "windows", "linux"] as const)
      for (const r of all) {
        const w = readyWords(r, platform)!;
        expect(`${w.title} ${w.detail ?? ""} ${w.action?.label ?? ""}`).not.toMatch(/\bhub\b/i);
      }
  });

  it("name where Login Items are on each system", () => {
    const off: Readiness = { kind: "blocked", status: { state: "needs-approval" } };
    expect(readyWords(off, "macos")!.detail).toContain("System Settings → General → Login Items");
    expect(readyWords(off, "windows")!.action!.label).toBe("Open Startup apps");
  });
});
