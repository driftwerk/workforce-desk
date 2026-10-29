import { describe, expect, it } from "vitest";
import type { Room } from "../hub/types";
import { placeLabel, targetOf } from "./target";
import { agent, session } from "./testing";

const rooms: Record<string, Room> = {
  r1: { id: "r1", slug: "launch", name: "Launch", members: [], defaultMember: null, createdAt: "", updatedAt: "" },
};

describe("where a need or a turn opens", () => {
  it("opens a session, a DM, a call's agent and work elsewhere in the agent's DM", () => {
    expect(targetOf({ who: session("s-1"), place: { kind: "session" } }, "local", rooms)).toEqual({ kind: "session", sessionId: "s-1" });
    for (const place of [{ kind: "dm" }, { kind: "call" }, { kind: "elsewhere" }] as const)
      expect(targetOf({ who: agent("scout"), place }, "b", rooms)).toEqual({ kind: "agent", key: "b/scout" });
  });

  it("opens a room this Mac has, at its thread, and the DM for a room it doesn't", () => {
    expect(targetOf({ who: agent("scout"), place: { kind: "room", room: "r1", thread: "m-9" } }, "local", rooms)).toEqual({
      kind: "room",
      roomId: "r1",
      threadId: "m-9",
    });
    expect(targetOf({ who: agent("scout"), place: { kind: "room", room: "elsewhere", thread: null } }, "b", rooms)).toEqual({
      kind: "agent",
      key: "b/scout",
    });
    expect(placeLabel({ kind: "room", room: "r1", thread: null }, rooms)).toBe("in Launch");
    expect(placeLabel({ kind: "room", room: "elsewhere", thread: null }, rooms)).toBe("in a room on another Mac");
  });

  it("opens Slack where the turn was", () => {
    expect(targetOf({ who: agent("scout"), place: { kind: "slack", team: "T1", channel: "C2", thread: "1.2" } }, "b", rooms)).toEqual({
      kind: "slack",
      url: "https://slack.com/app_redirect?team=T1&channel=C2",
    });
    expect(targetOf({ who: agent("scout"), place: { kind: "slack", team: null, channel: "C2", thread: null } }, "b", rooms)).toEqual({
      kind: "slack",
      url: "https://slack.com/app_redirect?channel=C2",
    });
    expect(placeLabel({ kind: "slack", team: null, channel: "C2", thread: null }, rooms)).toBe("in Slack");
    expect(placeLabel({ kind: "dm" }, rooms)).toBeNull();
  });
});
