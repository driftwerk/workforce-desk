import { describe, expect, it } from "vitest";
import type { Room, RoomMessage } from "../hub/types";
import { actionsFor, quoteFor } from "./actions";

const room: Room = {
  id: "r1",
  slug: "atlas-launch",
  name: "Atlas launch",
  members: [
    { hub: "local", agent: "allan" },
    { hub: "dw", agent: "sarah" },
  ],
  defaultMember: "local/allan",
  createdAt: "",
  updatedAt: "",
};
const m = (over: Partial<RoomMessage> = {}): RoomMessage => ({ id: "m1", roomId: "r1", threadId: null, author: "dw/sarah", content: "hi", hop: 0, createdAt: "", ...over });
const ids = (msg: RoomMessage, inThread = false) => actionsFor(msg, { inThread, room, name: "Sarah" }).map((a) => a.id);

describe("a room message's actions", () => {
  it("offers a member's message everything in the menu's order, the first three on the bar", () => {
    expect(ids(m({ inReplyTo: "q1" }))).toEqual(["thread", "copyText", "askSomeone", "copyLink", "askAgain", "markUnread", "dm", "makeLead", "removeFromRoom"]);
  });

  it("asks again only an answer that names what it answered, by someone still in the room", () => {
    expect(ids(m())).not.toContain("askAgain");
    expect(ids(m({ author: "dw/gone", inReplyTo: "q1" }))).not.toContain("askAgain");
  });

  it("leaves the lead without Make lead, and you and Desk without member actions", () => {
    expect(ids(m({ author: "local/allan" }))).not.toContain("makeLead");
    expect(ids(m({ author: "you" }))).toEqual(["thread", "copyText", "askSomeone", "copyLink", "markUnread"]);
  });

  it("posts a thread message to the room once, and never a copy", () => {
    expect(ids(m({ threadId: "t1" }), true)).toContain("postToRoom");
    expect(ids(m({ threadId: "t1", postedToRoom: true }), true)).not.toContain("postToRoom");
    expect(ids(m({ threadId: "t1" }), true)).not.toContain("thread");
  });

  it("views a copy's thread instead of replying under it", () => {
    expect(actionsFor(m({ copyOf: "orig" }), { inThread: false, room, name: "Sarah" })[0]).toEqual({ id: "thread", label: "View thread" });
  });
});

describe("quoting a message", () => {
  it("keeps six lines under who said it", () => {
    expect(quoteFor({ content: "one\ntwo" }, "Sarah")).toBe("> **Sarah:** \n> one\n> two");
    expect(quoteFor({ content: "1\n2\n3\n4\n5\n6\n7" }, "Sarah").split("\n").slice(-2)).toEqual(["> 6", "> …"]);
  });
});
