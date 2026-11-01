import { describe, expect, it, vi } from "vitest";
import { readConversation, type HubMessage } from "../chat/history";
import type { HubAccount } from "../chat/types";
import { HubError } from "../hub/client";
import type { NewRoomMessage, Room } from "../hub/types";
import { cursorKey, Drainer, placements, sourceKey, type DrainDeps } from "./drain";

const MINE = "6f1c2a4e-0b7d-4c55-9a51-3d2e8f9b1c07";
const GONE = "11111111-2222-4333-8444-555555555555";
const OTHER_MAC = "99999999-2222-4333-8444-555555555555";
const channel = `desk:${MINE}`;

const room: Room = {
  id: MINE,
  slug: "release",
  name: "Release",
  channel,
  members: [{ hub: "dw", agent: "allan" }],
  defaultMember: null,
  createdAt: "",
  updatedAt: "",
};
const hub: HubAccount = { id: "dw", label: "Driftwerk", url: "https://dw.example.com", local: false, revision: "t" };

const said = (id: string, mark: HubMessage["mark"], from = "agent", text = id): HubMessage => ({ id, from, text, mark });
const where = { hubId: "dw", agentId: "allan", channel, rooms: { [MINE]: room }, deleted: new Set([GONE]) };

describe("where a drained message goes", () => {
  it("puts answers and deliveries in this computer's room and thread, a deleted room's back to the hub, and leaves the rest", () => {
    const plan = placements(
      [
        said("u1", { room: MINE }, "user"),
        said("a1", { room: MINE, thread: "t1" }),
        said("d1", { room: MINE, delivery: "reminder" }),
        said("g1", { room: GONE }),
        said("o1", { room: OTHER_MAC }),
        said("x1", null),
      ],
      where,
    );
    expect(plan.map((p) => p.kind)).toEqual(["skip", "room", "room", "gone", "skip", "skip"]);
    expect(plan[1]).toMatchObject({ threadId: "t1", source: "dw/allan/a1" });
    expect(plan[2]).toMatchObject({ threadId: null, source: "dw/allan/d1" });
  });

  it("takes a thread the room no longer has to the hub as it is: the hub places it in the timeline", () => {
    expect(placements([said("a1", { room: MINE, thread: "deleted-thread" })], where)[0]).toMatchObject({ kind: "room", threadId: "deleted-thread" });
  });

  it("refreshes a DM, and never puts a room's message in another room's conversation", () => {
    expect(placements([said("a1", null)], { ...where, channel: "desk" })[0]).toMatchObject({ kind: "dm" });
    expect(placements([said("a1", { room: MINE })], { ...where, channel: "desk:release" })[0]).toMatchObject({ kind: "skip" });
  });

  it("keys a source as the hub's own posts do", () => {
    expect(sourceKey("local", "scout", "m-1")).toBe("local/scout/m-1");
  });
});

/** A drainer over `pages` (the conversation as the hub keeps it). */
const drainer = (all: HubMessage[], patch: Partial<DrainDeps> = {}) => {
  const cursors = new Map<string, string>();
  const posted: NewRoomMessage[] = [];
  const replied: string[] = [];
  const reads: (string | undefined)[] = [];
  const deps: DrainDeps = {
    read: async (_hub, _agent, at) => {
      reads.push(at.after);
      const from = at.after ? all.findIndex((m) => m.id === at.after) + 1 : 0;
      if (at.after && from === 0) throw new HubError(400, "after names no message of this conversation");
      return { messages: all.slice(from), more: false };
    },
    post: async (_room, m) => {
      posted.push(m);
      return {
        message: { id: `p${posted.length}`, roomId: MINE, threadId: m.threadId ?? null, author: m.author, content: m.content, hop: m.hop ?? 0, createdAt: "" },
        created: true,
      };
    },
    close: vi.fn(async () => undefined),
    dm: vi.fn(),
    replied: (_room, _hub, _agent, posted) => void replied.push(posted.content),
    hopOf: () => 1,
    rooms: () => ({ [MINE]: room }),
    deleted: () => new Set([GONE]),
    cursors: { get: (k) => cursors.get(k), set: (k, v) => void cursors.set(k, v), remove: (k) => void cursors.delete(k) },
    ...patch,
  };
  return { d: new Drainer(deps), deps, cursors, posted, replied, reads };
};

const key = cursorKey("dw", "allan", channel);

describe("draining a conversation", () => {
  it("posts in order, hands on only answers, and moves its cursor past what it placed", async () => {
    const { d, posted, replied, cursors } = drainer([
      said("a1", { room: MINE, thread: "t1" }, "agent", "done @scout"),
      said("d1", { room: MINE, delivery: "job", request_id: "r1" }, "agent", "job done"),
    ]);
    await d.drain(hub, "allan", channel);
    expect(posted).toEqual([
      expect.objectContaining({ author: "dw/allan", content: "done @scout", threadId: "t1", hop: 1, source: "dw/allan/a1" }),
      expect.objectContaining({ content: "job done", hop: 0, delivery: "job", requestId: "r1", source: "dw/allan/d1" }),
    ]);
    expect(replied).toEqual(["done @scout"]);
    expect(cursors.get(key)).toBe("d1");
  });

  it("moves its cursor only past what was posted, and tries the rest again next time", async () => {
    let fail = true;
    const { d, cursors, deps } = drainer([said("a1", { room: MINE }), said("a2", { room: MINE })]);
    const post = deps.post;
    deps.post = async (roomId, m) => {
      if (m.source === "dw/allan/a2" && fail) throw new TypeError("offline");
      return post(roomId, m);
    };
    await d.drain(hub, "allan", channel);
    expect(cursors.get(key)).toBe("a1");
    fail = false;
    await d.drain(hub, "allan", channel);
    expect(cursors.get(key)).toBe("a2");
  });

  it("moves past a post the room refuses, which a later drain would only refuse again", async () => {
    const { d, cursors, deps } = drainer([said("a1", { room: MINE }), said("a2", { room: MINE })]);
    const post = deps.post;
    deps.post = async (roomId, m) => {
      if (m.source === "dw/allan/a1") throw new HubError(409, "loop guard");
      return post(roomId, m);
    };
    await d.drain(hub, "allan", channel);
    expect(cursors.get(key)).toBe("a2");
  });

  it("hands a deleted room's messages back to the hub to land in the DM", async () => {
    const { d, deps, cursors } = drainer([said("g1", { room: GONE }), said("g2", { room: GONE })]);
    await d.drain(hub, "allan", channel);
    expect(deps.close).toHaveBeenCalledWith(hub, "allan", channel, ["g1", "g2"]);
    expect(cursors.get(key)).toBe("g2");
  });

  it("never takes a file of its own for a cursor", async () => {
    const { d, cursors } = drainer([said("a1", { room: MINE }), said("file:art_1", null)]);
    await d.drain(hub, "allan", channel);
    expect(cursors.get(key)).toBe("a1");
  });

  it("reads from the newest again when its cursor names no message any more", async () => {
    const { d, cursors, reads } = drainer([said("a1", { room: MINE })]);
    cursors.set(key, "vanished");
    await d.drain(hub, "allan", channel);
    expect(reads).toEqual(["vanished", undefined]);
    expect(cursors.get(key)).toBe("a1");
  });

  it("drains one conversation at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const { d, deps } = drainer([said("a1", { room: MINE })]);
    const read = deps.read;
    deps.read = async (...args) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return read(...args);
    };
    await Promise.all([d.drain(hub, "allan", channel), d.drain(hub, "allan", channel)]);
    expect(most).toBe(1);
  });

  it("reads from the newest again when the hub says its cursor names no message, as a hub's refusal", async () => {
    const all = [said("a1", { room: MINE })];
    const reads: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: URL | string) => {
        const after = new URL(u).searchParams.get("after") ?? undefined;
        reads.push(after);
        return after
          ? new Response(JSON.stringify({ error: "after names no message of this conversation" }), { status: 400, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ messages: all, more: false }), { headers: { "content-type": "application/json" } });
      }),
    );
    const { d, cursors } = drainer(all, { read: readConversation });
    cursors.set(key, "vanished");
    expect(await d.drain(hub, "allan", channel)).toBe(true);
    expect(reads).toEqual(["vanished", undefined]);
    expect(cursors.get(key)).toBe("a1");
    vi.unstubAllGlobals();
  });

  it("leaves a post for next time when the hub may take it later, and says the drain isn't done", async () => {
    for (const status of [401, 408, 429, 503]) {
      const { d, cursors, deps } = drainer([said("a1", { room: MINE })]);
      deps.post = async () => {
        throw new HubError(status, "not now");
      };
      expect(await d.drain(hub, "allan", channel)).toBe(false);
      expect(cursors.get(key)).toBeUndefined();
    }
  });

  it("remembers what it drained lately, to tell of a delivery an earlier drain placed", async () => {
    const { d } = drainer([said("a1", { room: MINE }), said("a2", { room: MINE })]);
    await d.drain(hub, "allan", channel);
    await d.drain(hub, "allan", channel);
    expect(d.said("dw", "allan", "a2")?.text).toBe("a2");
    expect(d.said("dw", "scout", "a2")).toBeUndefined();
  });

  it("makes one drain of those asked for while one waits to begin", async () => {
    const { d, reads } = drainer([said("a1", { room: MINE })]);
    await Promise.all([d.drain(hub, "allan", channel), d.drain(hub, "allan", channel), d.drain(hub, "allan", channel)]);
    expect(reads).toEqual([undefined]);
  });

  it("takes a file's hub and agent from the conversation it was read from, never from the message", async () => {
    const { d, posted } = drainer([{ ...said("a1", { room: MINE }), attachments: [{ filename: "x.png", media_type: "image/png", artifact_id: "f1", size: 3, hub: "local", agent: "scout" }] }]);
    await d.drain(hub, "allan", channel);
    expect(posted[0]!.attachments).toEqual([expect.objectContaining({ artifact_id: "f1", hub: "dw", agent: "allan" })]);
  });

  it("tells a DM it has something new", async () => {
    const { d, deps } = drainer([said("u1", null, "user"), said("a1", { delivery: "reminder" })]);
    await d.drain(hub, "allan", "desk");
    expect(deps.dm).toHaveBeenCalledWith(hub, "allan", [expect.objectContaining({ id: "a1" })]);
  });

  it("posts what an answer answers and the tools its turn ran, as its mark says; one without them posts neither", async () => {
    const steps = [{ tool: "repo.search", ok: true, ms: 1200 }];
    const { d, posted } = drainer([
      said("a1", { room: MINE, in_reply_to: "q1", steps }),
      said("a2", { room: MINE }),
      said("d1", { room: MINE, delivery: "job", in_reply_to: "q2", steps }),
    ]);
    await d.drain(hub, "allan", channel);
    expect(posted[0]).toMatchObject({ inReplyTo: "q1", steps });
    expect(posted[1]).not.toHaveProperty("inReplyTo");
    expect(posted[1]).not.toHaveProperty("steps");
    expect(posted[2]).toMatchObject({ inReplyTo: "q2" });
    expect(posted[2]).not.toHaveProperty("steps");
  });
});
