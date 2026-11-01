import { afterEach, describe, expect, it, vi } from "vitest";
import { deskState } from "../restore/boot";
import { reloadDesk } from "./reload";

describe("reloading Desk", () => {
  afterEach(() => vi.restoreAllMocks());

  it("flushes pending state, then reloads the window", async () => {
    const calls: string[] = [];
    vi.spyOn(deskState, "flush").mockImplementation(async () => void calls.push("flush"));
    const reload = vi.fn(() => void calls.push("reload"));
    vi.stubGlobal("location", { ...window.location, reload });
    await reloadDesk();
    expect(calls).toEqual(["flush", "reload"]);
    vi.unstubAllGlobals();
  });

  it("still reloads when the flush fails", async () => {
    vi.spyOn(deskState, "flush").mockRejectedValue(new Error("disk"));
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    await reloadDesk();
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
