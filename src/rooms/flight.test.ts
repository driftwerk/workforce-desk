import { describe, expect, it } from "vitest";
import type { FloorNeed } from "../floor/merge";
import type { RoomDraft } from "../hub/store";
import type { Room, RoomMessage } from "../hub/types";
import { flightRows } from "./flight";

const room = { id: "r1", slug: "atlas-launch", name: "Atlas launch", members: [], defaultMember: null, createdAt: "", updatedAt: "" } as Room;
const draft = (id: string, threadId: string | null, state: RoomDraft["state"], since = 0): RoomDraft => ({
  id,
  member: "local/allan",
  threadId,
  asked: "q1",
  since,
  text: "",
  working: null,
  tools: [],
  attachments: [],
  prompts: [],
  state,
});
const asked = { id: "q1", roomId: "r1", threadId: null, author: "you", content: "Ship it?", hop: 0, createdAt: "" } as RoomMessage;
const parent = { ...asked, id: "t2", content: "Changelog" };

describe("what's in flight in your rooms", () => {
  it("is one row per thread and one for the main timeline, in its worst state, needs first", () => {
    const need = { place: { kind: "room", room: "r1", thread: "t3" } } as FloorNeed;
    const rows = flightRows(
      { r1: room },
      [{ roomId: "r1", main: { count: 0, forYou: 0, first: null, lastAt: null }, threads: [{ parent, unread: { count: 2, forYou: 0, first: null, lastAt: "2026-10-30T09:00:00Z" } }] }],
      { r1: [draft("a", null, "live", 5), draft("b", null, "queued", 6), draft("c", "t1", "failed")] },
      [need],
      { r1: [asked] },
    );
    expect(rows.map((r) => [r.key, r.state])).toEqual([
      ["r1/t3", "needs"],
      ["r1/t1", "failed"],
      ["r1", "working"],
      ["r1/t2", "unread"],
    ]);
    expect(rows[2]).toMatchObject({ parent: asked, since: 5, members: ["local/allan"] });
    expect(rows[3]!.parent).toEqual(parent);
  });
});
