import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../restore/boot", () => ({
  deskState: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => void state.set(k, v), remove: (k: string) => void state.delete(k) },
}));

const { useChat } = await import("../chat/store");
const { deskListeners, useDesk } = await import("../hub/store");
const { useReads } = await import("./reads");
const { dmsFrom, startUnread, SUMMARY_DEBOUNCE_MS, useUnread } = await import("./summary");

const dw = { id: "dw", label: "Atlas", url: "https://atlas.example.com", local: false, token: "t" };
const row = (agent: string, count: number, forYou = count) => ({
  agent_id: agent,
  channel: "desk",
  updated_at: "",
  read: { at: "2026-10-30T09:00:00Z", message_id: "m0" },
  unread: { count, for_you: forYou, first: null, last: null, capped: false },
});
const summary = { floor: "2026-10-01T00:00:00Z", rooms: [], sessions: [], activity: { count: 0, lastAt: null }, brief: null, update: null };

beforeEach(() => {
  state.clear();
  useUnread.setState({ local: null, localAt: null, dms: { "local/scout": { count: 1, for_you: 1, first: null, last: null, capped: false } }, dmsAt: {} });
  useReads.setState({ local: {}, dms: {}, loaded: false });
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "", local: true, token: "" }, dw] });
});

describe("DM counts", () => {
  it("take a hub's listing as all that's unread on it, leaving other hubs' alone, and its read points", () => {
    useUnread.setState((s) => ({ dms: { ...s.dms, "dw/sarah": { count: 5, for_you: 5, first: null, last: null, capped: false } } }));
    dmsFrom(dw, [row("allan", 2), row("sarah", 0), { agent_id: "allan", channel: "desk:r1", updated_at: "" }]);
    expect(Object.keys(useUnread.getState().dms).sort()).toEqual(["dw/allan", "local/scout"]);
    expect(useReads.getState().dms["dw/sarah"]).toEqual({ at: "2026-10-30T09:00:00Z", message: "m0" });
    expect(state.get("unread.cache.dw")).toMatchObject({ dms: { "dw/allan": { count: 2 } } });
  });

  it("clear once a hub that keeps read points lists nothing unread", () => {
    useChat.setState({ hubFeatures: { dw: new Set(["desk.reads"]) } });
    dmsFrom(dw, [row("allan", 2)]);
    dmsFrom(dw, []);
    expect(Object.keys(useUnread.getState().dms)).toEqual(["local/scout"]);
    useChat.setState({ hubFeatures: {} });
  });

  it("say nothing from a hub that keeps no read points", () => {
    dmsFrom(dw, [{ agent_id: "allan", channel: "desk", updated_at: "" }]);
    expect(Object.keys(useUnread.getState().dms)).toEqual(["local/scout"]);
  });
});

describe("this computer's summary", () => {
  it("is read on a snapshot, and once events settle after a change", async () => {
    vi.useFakeTimers();
    const unread = vi.fn(async () => summary);
    const reads = vi.fn(async () => [{ place: "room:r1", at: "2026-10-30T09:00:00Z", message: "m1" }]);
    useDesk.setState({ hub: { unread, reads } as never });
    const stop = startUnread();
    for (const f of deskListeners) f({ type: "snapshot", sessions: [], restore: [], rooms: [] });
    await vi.waitFor(() => expect(useReads.getState().loaded).toBe(true));
    expect(unread).toHaveBeenCalledTimes(1);
    for (const f of deskListeners) {
      f({ type: "roomMessage", message: {} as never });
      f({ type: "read", place: "room:r2", point: { at: "2026-10-30T10:00:00Z", message: "m9" } });
    }
    expect(useReads.getState().local["room:r2"]).toEqual({ at: "2026-10-30T10:00:00Z", message: "m9" });
    await vi.advanceTimersByTimeAsync(SUMMARY_DEBOUNCE_MS);
    expect(unread).toHaveBeenCalledTimes(2);
    expect(state.get("unread.cache.local")).toMatchObject({ local: summary });
    stop();
    vi.useRealTimers();
  });
});
