import { describe, expect, it } from "vitest";
import type { FloorNeed } from "../floor/merge";
import { agent, need, session } from "../floor/testing";
import type { RoomDraft } from "../hub/store";
import type { RoomMessage, RoomSummary } from "../hub/types";
import {
  badgeOfDm,
  badgeOfFloor,
  badgeOfGroup,
  badgeOfRoom,
  badgeOfSession,
  countLabel,
  inRoom,
  itemBadge,
  ofItem,
  pastPoints,
  totalOf,
} from "./badges";

const tagged = (n: ReturnType<typeof need>, hubId = "dw"): FloorNeed => ({ ...n, hubId, local: hubId === "local", key: `${hubId}:${n.id}`, stale: false });
const inRoomNeed = tagged(need("n1", agent("allan", "Allan"), { place: { kind: "room", room: "r1", thread: null } }));
const dmNeed = tagged(need("n2", agent("allan", "Allan")));
const blocked = tagged(need("n3", session("s1")), "local");
const unread = (count: number, forYou: number) => ({ count, forYou, first: null, lastAt: null });
const parent = { id: "t1", roomId: "r1", threadId: null, author: "you", content: "", hop: 0, createdAt: "" } as RoomMessage;
const summary: RoomSummary = { roomId: "r1", main: unread(3, 1), threads: [{ parent, unread: unread(2, 2) }] };
const draft = (state: RoomDraft["state"], prompts = 0): RoomDraft => ({
  id: state,
  member: "dw/allan",
  threadId: null,
  asked: "q",
  since: 0,
  text: "",
  working: null,
  tools: [],
  attachments: [],
  prompts: Array.from({ length: prompts }, (_, i) => ({ requestId: `p${i}`, tool: "t", content: "", options: {} as never, turnRef: null })),
  state,
});
const dm = (count: number, forYou: number) => ({ count, for_you: forYou, first: null, last: null, capped: false });

describe("badges", () => {
  it("counts a room need by its room, never by its agent's DM", () => {
    const needs = [inRoomNeed, dmNeed];
    expect(ofItem(needs, "agent:dw/allan")).toEqual([dmNeed]);
    expect(inRoom(needs, "r1")).toEqual([inRoomNeed]);
    expect(badgeOfDm(dm(4, 1), ofItem(needs, "agent:dw/allan"))).toEqual({ count: 2, dot: false });
  });

  it("leaves out a DM read here past its newest message since its hub counted it", () => {
    const last = (at: string) => ({ ...dm(2, 2), last: { at, message_id: "m9" } });
    const dms = { "dw/allan": last("2026-10-30T09:00:00Z"), "dw/sarah": last("2026-10-30T09:00:00Z"), "dw/atlas": dm(1, 1) };
    const points = { "dw/allan": { at: "2026-10-30T09:00:00.000Z", message: "m9" }, "dw/sarah": { at: "2026-10-30T08:00:00Z", message: "m1" } };
    expect(Object.keys(pastPoints(dms, points)).sort()).toEqual(["dw/atlas", "dw/sarah"]);
    expect(pastPoints(dms, {})).toBe(dms);
  });

  it("shows only a dot for what's new and none of it for you", () => {
    expect(badgeOfDm(dm(3, 0), [])).toEqual({ count: 0, dot: true });
    expect(badgeOfDm(undefined, [])).toEqual({ count: 0, dot: false });
    expect(badgeOfSession({ id: "s1", since: "", urgency: "new" }, [])).toEqual({ count: 0, dot: true });
    expect(badgeOfSession({ id: "s1", since: "", urgency: "forYou" }, [blocked])).toEqual({ count: 2, dot: false });
  });

  it("counts a room's answers to you, its needs, and its failed and stopped answers; its working ring while one answers", () => {
    expect(badgeOfRoom(summary, [draft("live"), draft("failed"), draft("stopped")], [inRoomNeed])).toEqual({ count: 6, dot: false, working: true });
    expect(badgeOfRoom({ ...summary, main: unread(2, 0), threads: [] }, [], [])).toEqual({ count: 0, dot: true, working: false });
  });

  it("counts a draft's prompts only on a hub without a Floor, which would list them", () => {
    expect(badgeOfRoom(undefined, [draft("live", 2)], [], () => true).count).toBe(0);
    expect(badgeOfRoom(undefined, [draft("live", 2)], [], () => false).count).toBe(2);
  });

  it("sums a group's or grid's items, and the Floor's needs, brief and Activity", () => {
    expect(badgeOfGroup([{ count: 2, dot: false }, { count: 0, dot: true }])).toEqual({ count: 2, dot: false });
    expect(badgeOfGroup([{ count: 0, dot: true }])).toEqual({ count: 0, dot: true });
    expect(badgeOfFloor([dmNeed], { count: 4, lastAt: null }, "2026-10-30T08:00:00Z")).toEqual({ count: 2, dot: false });
    expect(badgeOfFloor([], { count: 4, lastAt: null }, null)).toEqual({ count: 0, dot: true });
  });

  it("totals each item once, with a dot only for what's only new", () => {
    const local = { floor: "", rooms: [summary], sessions: [{ id: "s1", since: "", urgency: "forYou" as const }], activity: { count: 0, lastAt: null }, brief: "x", update: null };
    expect(totalOf({ needs: [inRoomNeed, dmNeed, blocked], dms: { "dw/allan": dm(4, 1) }, local, drafts: { r1: [draft("failed")] }, update: false })).toEqual({ count: 10, dot: false });
    expect(totalOf({ needs: [], dms: {}, local: null, drafts: {}, update: true })).toEqual({ count: 0, dot: true });
  });

  it("reads an item's badge from its key", () => {
    const d = { needs: [dmNeed, blocked], dms: { "dw/allan": dm(1, 1) }, sessions: [] };
    expect(itemBadge("agent:dw/allan", d)).toEqual({ count: 2, dot: false });
    expect(itemBadge("session:s1", d)).toEqual({ count: 1, dot: false });
  });

  it("says 99+ past 99", () => {
    expect(countLabel(99)).toBe("99");
    expect(countLabel(100)).toBe("99+");
  });
});
