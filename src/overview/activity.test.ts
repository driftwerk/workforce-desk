import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubError, type DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { ActivityEvent, ActivityFilter, ActivityPage } from "../hub/types";
import { lineOf, matches, mergeEvents } from "./activity";
import { onDeskEvent, useOverview } from "./store";

const ev = (id: string, at: string, over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id,
  at: `2026-10-28T${at}:00Z`,
  kind: "started",
  actor: { kind: "session", id: "e7", name: "workforce-e7" },
  subject: { kind: "session", id: "e7", name: "workforce-e7" },
  text: "started “Provider list for Desk”",
  ...over,
});

const manager = { kind: "manager" as const, id: "desk", name: "Desk" };

describe("activity lists", () => {
  it("merge newest first, each event once", () => {
    const merged = mergeEvents([ev("b", "10:05"), ev("a", "10:00")], [ev("c", "10:10"), ev("b", "10:05", { text: "again" })]);
    expect(merged.map((e) => e.id)).toEqual(["c", "b", "a"]);
    expect(merged[1]!.text).toBe("again");
  });

  it("place a live event only in the filters it belongs to", () => {
    const asked = ev("q", "10:15", { kind: "question" });
    const nudged = ev("n", "10:24", { kind: "nudged", actor: manager });
    expect(matches("all", asked) && matches("needs_you", asked) && !matches("manager", asked)).toBe(true);
    expect(matches("manager", nudged) && !matches("needs_you", nudged)).toBe(true);
  });

  it("call sessions by the names you gave them in Desk, split where the hub named them", () => {
    const names = { e7: "date picker" };
    expect(lineOf(ev("s", "09:58"), names).lead).toEqual({ name: "date picker", session: true });
    expect(
      lineOf(ev("n", "10:24", { kind: "nudged", actor: manager, text: "asked workforce-e7 “Still stuck?”" }), names).parts,
    ).toEqual([{ text: "asked " }, { text: "date picker", session: true, name: true }, { text: " “Still stuck?”" }]);
  });

  it("read as sentences about who did what", () => {
    expect(lineOf(ev("s", "09:58"))).toEqual({
      lead: { name: "workforce-e7", session: true },
      parts: [{ text: "started “Provider list for Desk”" }],
    });
    expect(
      lineOf(ev("n", "10:24", { kind: "nudged", actor: manager, text: "asked workforce-e7 “Still on the provider tests, or stuck?”" })),
    ).toEqual({
      lead: { name: "Desk", session: false },
      parts: [{ text: "asked " }, { text: "workforce-e7", session: true, name: true }, { text: " “Still on the provider tests, or stuck?”" }],
    });
    expect(lineOf(ev("r", "10:05", { kind: "resumed", actor: manager, text: "resumed it after its usage limit reset" })).parts).toEqual([
      { text: "resumed it after its usage limit reset" },
      { text: " · " },
      { text: "workforce-e7", session: true, name: true },
    ]);
    expect(lineOf(ev("m", "09:00", { kind: "summary", actor: manager, subject: null, text: "sent your morning summary" }))).toEqual({
      lead: { name: "Desk", session: false },
      parts: [{ text: "sent your morning summary" }],
    });
  });
});

describe("the Activity rail's store", () => {
  const pages = new Map<string, ActivityPage>();
  const asked: { filter?: ActivityFilter; before?: string }[] = [];
  const activity = vi.fn(async (q: { filter?: ActivityFilter; before?: string }) => {
    asked.push(q);
    const page = pages.get(`${q.filter}:${q.before ?? ""}`);
    if (!page) throw new HubError(404, "nope");
    return structuredClone(page);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    pages.clear();
    asked.length = 0;
    useDesk.setState({ hub: { activity, overview: vi.fn(() => Promise.reject(new HubError(404, ""))) } as unknown as DeskHub });
    useOverview.setState({ feeds: {}, activitySupport: "unknown", overviewSupport: "unknown" });
  });
  afterEach(() => vi.useRealTimers());

  it("pages back with the oldest event shown", async () => {
    pages.set("all:", { events: [ev("c", "10:10"), ev("b", "10:05")], more: true });
    pages.set("all:b", { events: [ev("a", "10:00")], more: false });
    await useOverview.getState().loadActivity("all");
    expect(useOverview.getState().feeds.all).toMatchObject({ state: "ready", more: true });
    await useOverview.getState().loadEarlier("all");
    expect(asked.at(-1)).toMatchObject({ filter: "all", before: "b" });
    const feed = useOverview.getState().feeds.all!;
    expect(feed.events.map((e) => e.id)).toEqual(["c", "b", "a"]);
    expect(feed.more).toBe(false);
    await useOverview.getState().loadEarlier("all");
    expect(asked).toHaveLength(2);
  });

  it("merges live events into the lists they belong to", async () => {
    pages.set("all:", { events: [ev("b", "10:05")], more: false });
    pages.set("needs_you:", { events: [ev("q", "10:01", { kind: "question" })], more: false });
    await useOverview.getState().loadActivity("all");
    await useOverview.getState().loadActivity("needs_you");
    onDeskEvent({ type: "activity", event: ev("n", "10:24", { kind: "nudged", actor: manager }) });
    onDeskEvent({ type: "activity", event: ev("w", "10:18", { kind: "needs_you" }) });
    onDeskEvent({ type: "activity", event: ev("b", "10:05") });
    const { feeds } = useOverview.getState();
    expect(feeds.all!.events.map((e) => e.id)).toEqual(["n", "w", "b"]);
    expect(feeds.needs_you!.events.map((e) => e.id)).toEqual(["w", "q"]);
    expect(feeds.manager).toBeUndefined();
  });

  it("keeps live events that arrive while a page is being read", async () => {
    pages.set("all:", { events: [ev("b", "10:05")], more: false });
    const reading = useOverview.getState().loadActivity("all");
    onDeskEvent({ type: "activity", event: ev("n", "10:24") });
    await reading;
    expect(useOverview.getState().feeds.all!.events.map((e) => e.id)).toEqual(["n", "b"]);
  });

  it("knows a hub without Activity", async () => {
    await useOverview.getState().loadActivity("manager");
    expect(useOverview.getState().activitySupport).toBe("no");
    expect(useOverview.getState().feeds.manager!.state).toBe("failed");
  });
});
