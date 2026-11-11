import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HelperStatus } from "../platform";
import { explain, setStarter } from "../ui/problem";
import { afterStart, startLocalHelper } from "./helperNote";
import { useDesk } from "./store";

const platform = vi.hoisted(() => ({ startHelper: vi.fn(), openLoginItems: vi.fn() }));
vi.mock("../platform", () => platform);

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  platform.startHelper.mockReset();
  platform.openLoginItems.mockReset().mockResolvedValue(undefined);
  useDesk.setState({ error: null, connected: false });
  setStarter(startLocalHelper);
});

describe("Start it from an error toast", () => {
  it("is offered when the local helper is down, and starts it", async () => {
    platform.startHelper.mockResolvedValue({ state: "running" } satisfies HelperStatus);
    useDesk.getState().fail(new TypeError("Failed to fetch"));
    const fix = useDesk.getState().error!.fix!;
    expect(fix.label).toBe("Start it");
    fix.run!();
    useDesk.getState().clearError(); // as the toast does after a button
    await flush();
    expect(platform.startHelper).toHaveBeenCalledTimes(1);
    expect(useDesk.getState().error).toBeNull();
  });

  it("with the login item off, keeps a note up with the next step and its button", async () => {
    platform.startHelper.mockResolvedValue({ state: "needs-approval" });
    useDesk.getState().fail(new TypeError("x"));
    useDesk.getState().error!.fix!.run!();
    useDesk.getState().clearError(); // as the toast does after a button
    await flush();
    const next = useDesk.getState().error!;
    expect(next.plain).toBe("Desk Helper is turned off in your login items.");
    expect(next.fix?.label).toBe("Open login items");
    next.fix!.run!();
    expect(platform.openLoginItems).toHaveBeenCalled();
  });

  it("outside Applications, says to move Desk", async () => {
    platform.startHelper.mockResolvedValue({ state: "move-to-applications" });
    useDesk.getState().fail(new TypeError("x"));
    useDesk.getState().error!.fix!.run!();
    useDesk.getState().clearError(); // as the toast does after a button
    await flush();
    expect(useDesk.getState().error!.plain).toBe("Move Desk to your Applications folder, then open it from there.");
  });

  it("in a development run, says to start it by hand", async () => {
    platform.startHelper.mockResolvedValue({ state: "development" });
    useDesk.getState().fail(new TypeError("x"));
    useDesk.getState().error!.fix!.run!();
    useDesk.getState().clearError(); // as the toast does after a button
    await flush();
    expect(useDesk.getState().error!.plain).toMatch(/development run: start Desk’s helper by hand/);
  });

  it("a helper that failed keeps its message under Details", () => {
    const p = afterStart({ state: "failed", message: "Postgres failed: port 5433 is busy" })!;
    expect(p.plain).toBe("Desk’s helper couldn’t start.");
    expect(p.details).toBe("Postgres failed: port 5433 is busy");
  });

  it("when starting itself fails, says so as a problem", async () => {
    platform.startHelper.mockRejectedValue(new Error("not allowed"));
    useDesk.getState().fail(new TypeError("x"));
    useDesk.getState().error!.fix!.run!();
    useDesk.getState().clearError(); // as the toast does after a button
    await flush();
    expect(useDesk.getState().error!.plain).toBe("not allowed");
  });

  it("is not offered once the helper is up", () => {
    expect(explain(new TypeError("x"), { localDown: false }).fix?.label).not.toBe("Start it");
  });
});
