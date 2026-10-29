import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { localIso } from "../hub/floor";
import { SETTLE_MS, TICK_MS, useFloor, useFloorTick, watchFloor } from "./store";
import { agent, approval, fakeFetch, fakeHub, hub, need, view, type FakeHub } from "./testing";
import { renderHook } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));

let hubs: Record<string, FakeHub>;
let stop: () => void;

const settle = () => vi.advanceTimersByTimeAsync(SETTLE_MS + 1);
const floorOf = (id: string) => useFloor.getState().hubs[id];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-29T16:42:00"));
  hubs = {
    local: fakeHub({ floor: view({ needs: [approval("ap-1", "s-1")], counts: { working: 0, needsYou: 1, doneToday: 0 } }) }),
    b: fakeHub({ floor: view({ needs: [need("q-1", agent("scout"))] }) }),
  };
  vi.stubGlobal("fetch", fakeFetch(hubs));
  useFloor.setState({ hubs: {}, deciding: {}, problems: {}, answered: {} });
  useChat.setState({ hubs: [] });
  stop = watchFloor();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the floor's store", () => {
  it("reads a hub when it's added, once however often asked, and drops one removed", async () => {
    useChat.setState({ hubs: [hub("local"), hub("b")] });
    expect(floorOf("local")?.state).toBe("loading");
    await settle();
    expect(floorOf("local")?.floor?.needs.map((n) => n.id)).toEqual(["ap-1"]);
    expect(hubs.local!.days).toEqual([localIso(new Date("2026-10-29T00:00:00"))]);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(hubs.local!.days).toHaveLength(2);
    useChat.setState({ hubs: [hub("local")] });
    expect(floorOf("b")).toBeUndefined();
  });

  it("reads a hub paired again afresh", async () => {
    useChat.setState({ hubs: [hub("b")] });
    await settle();
    useChat.setState({ hubs: [hub("b", { token: "t-new" })] });
    expect(floorOf("b")?.state).toBe("loading");
    await settle();
    expect(floorOf("b")?.state).toBe("ready");
  });

  it("marks a hub without the route unsupported, and asks it again only when Desk comes forward", async () => {
    hubs.b!.floor = null;
    useChat.setState({ hubs: [hub("b")] });
    await settle();
    expect(floorOf("b")?.state).toBe("unsupported");
    const { unmount } = renderHook(() => useFloorTick(true));
    await vi.advanceTimersByTimeAsync(TICK_MS + SETTLE_MS);
    expect(hubs.b!.days).toHaveLength(1);
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(hubs.b!.days).toHaveLength(2);
    unmount();
  });

  it("keeps what a hub said when it can't be reached, marked stale, and reads it every minute while shown", async () => {
    useChat.setState({ hubs: [hub("b")] });
    await settle();
    hubs.b!.down = true;
    const { unmount } = renderHook(() => useFloorTick(true));
    await vi.advanceTimersByTimeAsync(TICK_MS + SETTLE_MS);
    expect(floorOf("b")).toMatchObject({ state: "ready", stale: true });
    expect(floorOf("b")?.floor?.needs).toHaveLength(1);
    hubs.b!.down = false;
    await vi.advanceTimersByTimeAsync(TICK_MS + SETTLE_MS);
    expect(floorOf("b")?.stale).toBe(false);
    unmount();
  });

  it("says a hub failed when it never answered", async () => {
    hubs.b!.down = true;
    useChat.setState({ hubs: [hub("b")] });
    await settle();
    expect(floorOf("b")?.state).toBe("failed");
  });

  it("reads again for the new day at midnight", async () => {
    useChat.setState({ hubs: [hub("local")] });
    await settle();
    await vi.advanceTimersByTimeAsync(new Date("2026-10-30T00:00:00").getTime() - Date.now() + SETTLE_MS);
    expect(hubs.local!.days.at(-1)).toBe(localIso(new Date("2026-10-30T00:00:00")));
    expect(useFloor.getState().day).toBe(new Date("2026-10-30T00:00:00").getTime());
  });

  it("allows a need, and shows it allowed until a read no longer has it", async () => {
    useChat.setState({ hubs: [hub("local")] });
    await settle();
    const n = floorOf("local")!.floor!.needs[0]!;
    hubs.local!.decide = () => {
      hubs.local!.floor = view();
      return 204;
    };
    const deciding = useFloor.getState().decide("local", n, "allow");
    expect(useFloor.getState().deciding).toEqual({ "local/ap-1": "allow" });
    await deciding;
    expect(hubs.local!.decided).toEqual([{ at: { kind: "session", sessionId: "s-1", approvalId: "ap-1" }, choice: "allow" }]);
    await settle();
    expect(floorOf("local")?.floor?.needs).toEqual([]);
    expect(useFloor.getState().deciding).toEqual({});
  });

  it("takes a need answered elsewhere off at once, saying so", async () => {
    useChat.setState({ hubs: [hub("local")] });
    await settle();
    hubs.local!.decide = () => 409;
    await useFloor.getState().decide("local", floorOf("local")!.floor!.needs[0]!, "allow");
    expect(floorOf("local")?.floor?.needs).toEqual([]);
    expect(floorOf("local")?.floor?.counts.needsYou).toBe(0);
    expect(Object.keys(useFloor.getState().answered)).toEqual(["local/ap-1"]);
    expect(useFloor.getState().deciding).toEqual({});
  });

  it("says plainly why an answer didn't go through, and keeps the need", async () => {
    useChat.setState({ hubs: [hub("local")] });
    await settle();
    hubs.local!.decide = () => 403;
    await useFloor.getState().decide("local", floorOf("local")!.floor!.needs[0]!, "deny");
    expect(useFloor.getState().problems["local/ap-1"]).toBe("Desk isn’t allowed to do that on this Mac.");
    expect(floorOf("local")?.floor?.needs).toHaveLength(1);
  });
});
