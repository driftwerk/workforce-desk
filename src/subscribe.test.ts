import { describe, expect, it, vi } from "vitest";
import { subscribe } from "./platform";

describe("subscribe", () => {
  it("unlistens once the listener arrives, when cleanup ran first", async () => {
    const unlisten = vi.fn();
    let arrive!: (u: () => void) => void;
    const stop = subscribe(new Promise((r) => (arrive = r)));
    stop();
    arrive(unlisten);
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("unlistens on cleanup after the listener arrived", async () => {
    const unlisten = vi.fn();
    const stop = subscribe(Promise.resolve(unlisten));
    await Promise.resolve();
    expect(unlisten).not.toHaveBeenCalled();
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
