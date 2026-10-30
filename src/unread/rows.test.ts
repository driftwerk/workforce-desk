import { describe, expect, it } from "vitest";
import type { Room, RoomMessage, Session } from "../hub/types";
import { unreadRows, type RowSources } from "./rows";

const at = (min: number) => new Date(Date.UTC(2026, 9, 30, 9, min)).toISOString();
const room = { id: "r1", slug: "atlas-launch", name: "Atlas launch", members: [], defaultMember: null, createdAt: "", updatedAt: "" } as Room;
const parent = { id: "t1", roomId: "r1", threadId: null, author: "you", content: "Which branch?\nmore", hop: 0, createdAt: "" } as RoomMessage;
const base: RowSources = {
  local: {
    floor: at(0),
    rooms: [{ roomId: "r1", main: { count: 2, forYou: 0, first: "m1", lastAt: at(5) }, threads: [{ parent, unread: { count: 1, forYou: 1, first: "m9", lastAt: at(3) } }] }],
    sessions: [{ id: "s1", since: at(8), urgency: "forYou" }],
    activity: { count: 4, lastAt: at(9) },
    brief: at(1),
    update: { at: at(0), message: "1.3.0" },
  },
  dms: { "dw/allan": { count: 3, for_you: 2, first: "d1", last: { at: at(7), message_id: "d3" }, capped: false } },
  rooms: { r1: room },
  roster: [{ hubId: "dw", id: "allan", name: "Allan", model: null, provider: null, isDefault: false }],
  sessions: { s1: { id: "s1", name: "acme-web", state: "done" } as Session },
  sessionNames: {},
  timelines: {},
  brief: { text: "Morning summary\nAll green.", at: at(1), by: { id: "desk", name: "Desk" } },
  ready: "1.4.0",
  readyAt: at(2),
};

describe("the Unread page's rows", () => {
  it("lists what's for you first, newest first, then what's only new", () => {
    expect(unreadRows(base).map((r) => [r.key, r.urgency, r.count])).toEqual([
      ["session:s1", "forYou", 1],
      ["dm:dw/allan", "forYou", 2],
      ["thread:r1/t1", "forYou", 1],
      ["brief", "forYou", 1],
      ["room:r1", "new", 2],
      ["update", "new", 0],
    ]);
  });

  it("says what each place is and opens it at its first unread item", () => {
    const rows = Object.fromEntries(unreadRows(base).map((r) => [r.key, r]));
    expect(rows["thread:r1/t1"]).toMatchObject({ title: "Atlas launch ▸ thread", line: "Which branch?", open: { kind: "room", threadId: "t1", messageId: "m9" } });
    expect(rows["dm:dw/allan"]).toMatchObject({ title: "Allan", read: { at: at(7), message: "d3" } });
    expect(rows.brief).toMatchObject({ title: "Desk report", line: "Morning summary" });
    expect(rows.update).toMatchObject({ title: "Desk 1.4.0 is ready", version: "1.4.0", read: { message: "1.4.0" } });
    expect(rows["session:s1"]).toMatchObject({ title: "acme-web", line: "Finished", unread: { message: null } });
  });

  it("leaves out an update already seen", () => {
    expect(unreadRows({ ...base, ready: "1.3.0" }).some((r) => r.key === "update")).toBe(false);
  });
});
