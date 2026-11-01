import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { localIso } from "../hub/floor";
import { deskListeners } from "../hub/store";
import { merged } from "./merge";
import { SETTLE_MS, TICK_MS, floorHeard, floorUnheard, useFloor, useFloorTick, watchFloor } from "./store";
import { agent, approval, fakeFetch, fakeHub, hub, need, view, work, type FakeHub } from "./testing";
import { renderHook } from "@testing-library/react";

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
  useFloor.setState({ hubs: {}, deciding: {}, problems: {}, answered: {}, heard: {} });
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
    useChat.setState({ hubs: [hub("b", { revision: "t-new" })] });
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

  it("reads a hub whose link keeps its floor on its word, and on the minute only while its work runs or its link is down", async () => {
    useChat.setState({ hubs: [hub("b")] });
    await settle();
    floorHeard("b", new Set(["desk.floor"]));
    await settle();
    expect(hubs.b!.days).toHaveLength(2);
    const { unmount } = renderHook(() => useFloorTick(true));
    await vi.advanceTimersByTimeAsync(TICK_MS + SETTLE_MS);
    expect(hubs.b!.days).toHaveLength(2);
    hubs.b!.floor = view({ working: [work(agent("scout"))] });
    floorHeard("b", new Set(["desk.floor"]));
    await settle();
    await vi.advanceTimersByTimeAsync(TICK_MS + SETTLE_MS);
    expect(hubs.b!.days).toHaveLength(4);
    hubs.b!.floor = view();
    await vi.advanceTimersByTimeAsync(TICK_MS + SETTLE_MS);
    await vi.advanceTimersByTimeAsync(TICK_MS + SETTLE_MS);
    expect(hubs.b!.days).toHaveLength(5);
    floorUnheard("b");
    await vi.advanceTimersByTimeAsync(TICK_MS + SETTLE_MS);
    expect(hubs.b!.days).toHaveLength(6);
    unmount();
  });

  it("asks a hub without a floor again when its link says it has one, and not when it says nothing of it", async () => {
    hubs.b!.floor = null;
    useChat.setState({ hubs: [hub("b")] });
    await settle();
    expect(floorOf("b")?.state).toBe("unsupported");
    floorHeard("b", new Set(["desk.deliveries"]));
    await settle();
    expect(hubs.b!.days).toHaveLength(1);
    expect(useFloor.getState().heard).toEqual({});
    hubs.b!.floor = view({ needs: [need("q-2", agent("scout"))] });
    floorHeard("b", new Set(["desk.deliveries", "desk.floor"]));
    expect(floorOf("b")?.state).toBe("loading");
    await settle();
    expect(floorOf("b")?.floor?.needs.map((n) => n.id)).toEqual(["q-2"]);
  });

  it("forgets a removed hub's link", async () => {
    useChat.setState({ hubs: [hub("b")] });
    await settle();
    floorHeard("b", new Set(["desk.floor"]));
    useChat.setState({ hubs: [] });
    expect(useFloor.getState().heard).toEqual({});
    await settle();
  });

  it("says a hub failed when it never answered", async () => {
    hubs.b!.down = true;
    useChat.setState({ hubs: [hub("b")] });
    await settle();
    expect(floorOf("b")?.state).toBe("failed");
  });

  it("reads a hub whose link is up again on the minute after a read of it failed", async () => {
    useChat.setState({ hubs: [hub("b")] });
    await settle();
    floorHeard("b", new Set(["desk.floor"]));
    hubs.b!.down = true;
    await settle();
    expect(floorOf("b")?.stale).toBe(true);
    hubs.b!.down = false;
    const { unmount } = renderHook(() => useFloorTick(true));
    await vi.advanceTimersByTimeAsync(TICK_MS + SETTLE_MS);
    expect(floorOf("b")?.stale).toBe(false);
    unmount();
  });

  it("asks a hub whose clock is behind for a day that has begun there, and the new day's floor once it has", async () => {
    useChat.setState({ hubs: [hub("local")] });
    await settle();
    useFloor.setState((s) => ({ hubs: { ...s.hubs, local: { ...s.hubs.local!, offset: -120_000 } } }));
    const midnight = new Date("2026-10-30T00:00:00").getTime();
    await vi.advanceTimersByTimeAsync(midnight - Date.now() + SETTLE_MS);
    expect(hubs.local!.days.at(-1)).toBe(localIso(new Date("2026-10-29T00:00:00")));
    expect(useFloor.getState().day).toBe(midnight);
    useFloor.setState((s) => ({ hubs: { ...s.hubs, local: { ...s.hubs.local!, offset: -120_000 } } }));
    await vi.advanceTimersByTimeAsync(120_000 + SETTLE_MS);
    expect(hubs.local!.days.at(-1)).toBe(localIso(new Date("2026-10-30T00:00:00")));
  });

  it("reads this computer's hub when its sessions move only while its link isn't saying so", async () => {
    useChat.setState({ hubs: [hub("local")] });
    await settle();
    const moved = () => deskListeners.forEach((f) => f({ type: "removed", id: "s-1" }));
    floorHeard("local", new Set(["desk.floor"]));
    await settle();
    const reads = hubs.local!.days.length;
    moved();
    await settle();
    expect(hubs.local!.days).toHaveLength(reads);
    floorUnheard("local");
    moved();
    await settle();
    expect(hubs.local!.days).toHaveLength(reads + 1);
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
    expect(merged(useFloor.getState().hubs, useChat.getState().hubs).counts.needsYou).toBe(0);
    expect(Object.keys(useFloor.getState().answered)).toEqual(["local/ap-1"]);
    expect(useFloor.getState().deciding).toEqual({});
  });

  it("doesn't bring back a need answered elsewhere from a read begun before it heard", async () => {
    useChat.setState({ hubs: [hub("local")] });
    await settle();
    const n = floorOf("local")!.floor!.needs[0]!;
    const plain = fakeFetch(hubs);
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const res = await plain(input, init);
        if (new URL(input).pathname === "/api/desk/floor") await held;
        return res;
      }),
    );
    const before = useFloor.getState().load("local");
    hubs.local!.decide = () => 409;
    await useFloor.getState().decide("local", n, "allow");
    release();
    await before;
    expect(floorOf("local")?.floor?.needs).toEqual([]);
    expect(Object.keys(useFloor.getState().answered)).toEqual(["local/ap-1"]);
    await useFloor.getState().load("local");
    expect(useFloor.getState().answered).toEqual({});
  });

  it("says plainly why an answer didn't go through, and keeps the need", async () => {
    useChat.setState({ hubs: [hub("local")] });
    await settle();
    hubs.local!.decide = () => 403;
    await useFloor.getState().decide("local", floorOf("local")!.floor!.needs[0]!, "deny");
    expect(useFloor.getState().problems["local/ap-1"]).toBe("Desk isn’t allowed to do that on this computer.");
    expect(floorOf("local")?.floor?.needs).toHaveLength(1);
  });
});
