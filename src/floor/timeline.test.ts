import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FloorLane } from "./merge";
import { asWho, axis, box, LANE_CAP, ordered } from "./timeline";
import { agent, session } from "./testing";

beforeAll(() => void vi.stubEnv("TZ", "Europe/London"));
afterAll(() => void vi.unstubAllEnvs());

const lane = (id: string, spans: FloorLane["spans"], hubId = "local"): FloorLane => ({
  who: agent(id),
  spans,
  hubId,
  local: hubId === "local",
  key: `${hubId}/agent:${id}`,
  stale: false,
});

describe("today's lanes", () => {
  it("scale a 25-hour day truly, a tick on each even local hour", () => {
    const day = Date.parse("2026-10-25T00:00:00+01:00");
    const now = Date.parse("2026-10-25T23:30:00Z");
    const a = axis([lane("a", [{ kind: "working", from: "2026-10-25T00:20:00+01:00", to: null }])], day, now);
    expect(a.from).toBe(day);
    expect(a.to - a.from).toBe(24.5 * 3_600_000);
    expect(a.ticks.map((t) => new Date(t).getHours())).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  });

  it("scale a 23-hour day truly", () => {
    const day = Date.parse("2026-03-29T00:00:00Z");
    const now = Date.parse("2026-03-29T22:59:00Z");
    const a = axis([lane("a", [{ kind: "working", from: "2026-03-29T00:10:00Z", to: "2026-03-29T03:00:00Z" }])], day, now);
    expect(a.to - a.from).toBe(22 * 3_600_000 + 59 * 60_000);
    expect(a.ticks.map((t) => new Date(t).getHours())).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  });

  it("start at the first span's hour, or an hour ago, never before midnight", () => {
    const day = Date.parse("2026-10-29T00:00:00Z");
    const now = Date.parse("2026-10-29T16:42:00Z");
    expect(axis([lane("a", [{ kind: "working", from: "2026-10-29T09:20:00Z", to: null }])], day, now).from).toBe(Date.parse("2026-10-29T09:00:00Z"));
    expect(axis([], day, now).from).toBe(now - 3_600_000);
    expect(axis([], day, day + 10 * 60_000).from).toBe(day);
  });

  it("place spans in percent, clipped to the day, never too thin to see", () => {
    const a = { from: 0, to: 100_000, ticks: [] };
    expect(box({ from: new Date(25_000).toISOString(), to: new Date(75_000).toISOString() }, a)).toEqual({ left: 25, width: 50 });
    expect(box({ from: new Date(-50_000).toISOString(), to: null }, a)).toEqual({ left: 0, width: 100 });
    expect(box({ from: new Date(50_000).toISOString(), to: new Date(50_010).toISOString() }, a).width).toBe(0.6);
    expect(box({ from: new Date(100_000).toISOString(), to: null }, a)).toEqual({ left: 99.4, width: 0.6 });
  });

  it("put what waits on you first, then what's working, then the latest", () => {
    const lanes = [
      lane("done-early", [{ kind: "working", from: "2026-10-29T08:00:00Z", to: "2026-10-29T09:00:00Z" }]),
      lane("done-late", [{ kind: "working", from: "2026-10-29T10:00:00Z", to: "2026-10-29T12:00:00Z" }]),
      lane("working", [{ kind: "working", from: "2026-10-29T10:00:00Z", to: null }]),
      lane("asking", [{ kind: "working", from: "2026-10-29T08:00:00Z", to: "2026-10-29T09:00:00Z" }]),
    ];
    const needs = [{ hubId: "local", local: true, key: "k", stale: false, who: agent("asking") }];
    const working = [{ hubId: "local", local: true, key: "w", stale: false, who: agent("working") }];
    expect(ordered(lanes, needs, working).map((l) => l.who.id)).toEqual(["asking", "working", "done-late", "done-early"]);
    expect(
      ordered([lane("s", [{ kind: "waiting", from: "2026-10-29T08:00:00Z", to: null }]), ...lanes.slice(0, 1)], [], []).map((l) => l.who.id),
    ).toEqual(["s", "done-early"]);
    expect(session("x").kind).toBe("session");
    expect(LANE_CAP).toBe(8);
  });

  it("put a session an agent's turn ran as in that agent's lane, spans of a kind joined where they meet", () => {
    const turn: FloorLane = { ...lane("t", []), who: session("t", "at-dm-d4774cbb6c89-2e"), key: "local/session:t" };
    const lanes = [
      { ...turn, spans: [{ kind: "working" as const, from: "2026-10-29T09:01:00Z", to: "2026-10-29T09:30:00Z" }, { kind: "waiting" as const, from: "2026-10-29T09:30:00Z", to: null }] },
      lane("scout", [
        { kind: "working", from: "2026-10-29T09:00:00Z", to: "2026-10-29T09:20:00Z" },
        { kind: "working", from: "2026-10-29T11:00:00Z", to: "2026-10-29T11:10:00Z" },
      ]),
      lane("other", [{ kind: "working", from: "2026-10-29T10:00:00Z", to: null }]),
    ];
    const folded = asWho(lanes, (l) => (l.who.id === "t" ? agent("scout", "") : l.who));
    expect(folded.map((l) => [l.key, l.who.name])).toEqual([
      ["local/agent:scout", "scout"],
      ["local/agent:other", "other"],
    ]);
    expect(folded[0]!.spans).toEqual([
      { kind: "working", from: "2026-10-29T09:00:00Z", to: "2026-10-29T09:30:00Z" },
      { kind: "waiting", from: "2026-10-29T09:30:00Z", to: null },
      { kind: "working", from: "2026-10-29T11:00:00Z", to: "2026-10-29T11:10:00Z" },
    ]);
    expect(asWho([turn], () => agent("scout", "Scout"))[0]).toMatchObject({ key: "local/agent:scout", who: { kind: "agent", name: "Scout" } });
    expect(asWho(lanes, (l) => l.who)).toEqual(lanes);
  });
});
