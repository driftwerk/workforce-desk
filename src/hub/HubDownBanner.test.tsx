import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { GRACE_MS, HubDownBanner, START_WAIT_MS, useHubDown } from "./HubDownBanner";
import { useDesk } from "./store";

const platform = vi.hoisted(() => ({
  startHelper: vi.fn(),
  helperLastReason: vi.fn(),
  openLoginItems: vi.fn(),
}));
vi.mock("../platform", () => platform);

/** The banner as App wires it. */
function Wired() {
  return (
    <div data-hub-down={useHubDown() || undefined} data-testid="app">
      <HubDownBanner down={useHubDown()} />
    </div>
  );
}

const flush = () => act(async () => {});
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  platform.startHelper.mockReset().mockResolvedValue({ state: "running" });
  platform.helperLastReason.mockReset().mockResolvedValue("Postgres failed: port 5433 is busy");
  platform.openLoginItems.mockReset();
  useHost.setState(DEFAULT_HOST);
  useDesk.setState({ connected: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the local hub is down", () => {
  it("says nothing while the hub is reachable, or for the first few seconds", async () => {
    render(<Wired />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => useDesk.setState({ connected: false }));
    await tick(GRACE_MS - 500);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("app").getAttribute("data-hub-down")).toBeNull();
  });

  it("says the hub isn't running, with the last logged reason, and marks what's shown stale", async () => {
    render(<Wired />);
    act(() => useDesk.setState({ connected: false }));
    await tick(GRACE_MS + 100);
    await flush();
    expect(screen.getByText("Desk’s helper isn’t running")).toBeTruthy();
    expect(screen.getByText(/Last logged: Postgres failed: port 5433 is busy/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start it" })).toBeTruthy();
    expect(screen.getByTestId("app").getAttribute("data-hub-down")).toBe("true");
  });

  it("is quiet about the reason when the log says nothing", async () => {
    platform.helperLastReason.mockResolvedValue(null);
    render(<Wired />);
    act(() => useDesk.setState({ connected: false }));
    await tick(GRACE_MS + 100);
    expect(screen.queryByText(/Last logged/)).toBeNull();
    expect(screen.getByRole("button", { name: "Start it" })).toBeTruthy();
  });

  it("asks the app to start it, shows it reconnecting, and goes once the hub answers", async () => {
    render(<Wired />);
    act(() => useDesk.setState({ connected: false }));
    await tick(GRACE_MS + 100);
    fireEvent.click(screen.getByRole("button", { name: "Start it" }));
    await flush();
    expect(platform.startHelper).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Starting Desk’s helper…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Starting…" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => useDesk.setState({ connected: true }));
    await flush();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("app").getAttribute("data-hub-down")).toBeNull();
  });

  it("says so when it was started but still doesn't answer", async () => {
    render(<Wired />);
    act(() => useDesk.setState({ connected: false }));
    await tick(GRACE_MS + 100);
    fireEvent.click(screen.getByRole("button", { name: "Start it" }));
    await flush();
    await tick(START_WAIT_MS + 100);
    expect(screen.getByText("It was started but isn’t answering yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start it" })).toBeTruthy();
  });

  it("says why when the app can't start it, and points at login items when they're off", async () => {
    platform.startHelper.mockResolvedValue({ state: "needs-approval" });
    render(<Wired />);
    act(() => useDesk.setState({ connected: false }));
    await tick(GRACE_MS + 100);
    fireEvent.click(screen.getByRole("button", { name: "Start it" }));
    await flush();
    expect(screen.getByText("Desk Helper is turned off in your login items.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open login items" }));
    expect(platform.openLoginItems).toHaveBeenCalled();
  });

  it("says a development run starts it by hand", async () => {
    platform.startHelper.mockResolvedValue({ state: "development" });
    render(<Wired />);
    act(() => useDesk.setState({ connected: false }));
    await tick(GRACE_MS + 100);
    fireEvent.click(screen.getByRole("button", { name: "Start it" }));
    await flush();
    expect(screen.getByText(/development run: start Desk’s helper by hand/)).toBeTruthy();
  });

  it("is not shown on Windows before Desk is set up, when there is no local hub", async () => {
    useHost.setState({ ...DEFAULT_HOST, platform: "windows", host: null });
    render(<Wired />);
    act(() => useDesk.setState({ connected: false }));
    await tick(GRACE_MS + 100);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
