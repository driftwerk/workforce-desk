import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

const { useDesk } = await import("../hub/store");
const { useOverview } = await import("../overview/store");
const { useFloorReads } = await import("./Floor");

const loadOverview = vi.fn(async () => {});
const loadManager = vi.fn(async () => {});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  loadOverview.mockClear();
  loadManager.mockClear();
  useOverview.setState({ loadOverview, loadManager, managerSupport: "yes", activitySupport: "yes" } as never);
  useDesk.setState({ hub: {} as never });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Reader() {
  useFloorReads();
  return null;
}

describe("the Floor's reads", () => {
  it("are one, however many Floors are shown, until the last goes", () => {
    const a = render(<Reader />);
    const b = render(<Reader />);
    const c = render(<Reader />);
    expect(loadOverview).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(loadOverview).toHaveBeenCalledTimes(2);
    a.unmount();
    b.unmount();
    vi.advanceTimersByTime(60_000);
    expect(loadOverview).toHaveBeenCalledTimes(3);
    c.unmount();
    vi.advanceTimersByTime(120_000);
    expect(loadOverview).toHaveBeenCalledTimes(3);
  });
});
