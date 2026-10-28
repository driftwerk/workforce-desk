import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: { agent: string; channel: string; text: string }[] = [];
const answerers = new Map<string, (content: string) => void>();

vi.mock("../chat/conversation", () => ({
  Conversation: class {
    constructor(
      _hub: unknown,
      private agent: string,
      _onChange: unknown,
      private channel: string,
      onAnswer: (c: string) => void,
    ) {
      answerers.set(agent, onAnswer);
    }
    send(text: string) {
      sent.push({ agent: this.agent, channel: this.channel, text });
      return true;
    }
    close() {}
  },
}));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { say, prune } = await import("./engine");
const { MAX_HOPS } = await import("./routing");

const room = {
  id: "r1",
  slug: "release",
  name: "release",
  members: [
    { hub: "dw", agent: "allan" },
    { hub: "local", agent: "scout" },
  ],
  defaultMember: "dw/allan",
  createdAt: "",
  updatedAt: "",
};

const posts: unknown[] = [];
const updates: unknown[] = [];

beforeEach(() => {
  sent.length = 0;
  posts.length = 0;
  updates.length = 0;
  answerers.clear();
  prune({});
  useChat.setState({
    hubs: [
      { id: "dw", label: "Driftwerk", url: "https://dw", local: false, token: "t" },
      { id: "local", label: "Local", url: "http://127.0.0.1:1", local: true, token: "t" },
    ],
    roster: [
      { hubId: "dw", id: "allan", name: "allan", model: null, provider: null, isDefault: false },
      { hubId: "local", id: "scout", name: "scout", model: null, provider: null, isDefault: false },
      { hubId: "local", id: "ledger", name: "Ledger", model: null, provider: null, isDefault: false },
      { hubId: "dw", id: "ledger", name: "Ledger", model: null, provider: null, isDefault: false },
      { hubId: "dw", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false },
    ],
  });
  useDesk.setState({
    rooms: { r1: room },
    hub: {
      post: async (_id: string, m: unknown) => (posts.push(m), m),
      updateRoom: async (id: string, patch: { members: typeof room.members }) => {
        updates.push(patch);
        return { ...useDesk.getState().rooms[id]!, ...patch };
      },
    } as never,
  });
});

describe("room engine", () => {
  it("keeps your message and sends it to the default member on the room's channel", async () => {
    await say(room, "what is left?", null);
    expect(posts).toEqual([{ author: "you", content: "what is left?", threadId: null }]);
    expect(sent).toEqual([{ agent: "allan", channel: "desk:release", text: "[#release] you: what is left?" }]);
  });

  it("posts an answer and hands it on to a mentioned member, one hop further", async () => {
    await say(room, "@allan status?", "t1");
    answerers.get("allan")!("migration is open, @scout can you check it");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(posts[1]).toEqual({ author: "dw/allan", content: "migration is open, @scout can you check it", threadId: "t1", hop: 0 });
    expect(sent[1]).toMatchObject({ agent: "scout", text: "[#release] allan: migration is open, @scout can you check it" });
    answerers.get("scout")!("checked: green");
    await vi.waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2]).toMatchObject({ author: "local/scout", hop: 1, threadId: "t1" });
  });

  it("brings someone mentioned into the room, and they answer", async () => {
    await say(room, "@atlas can you look?", null);
    expect(updates).toEqual([{ members: [...room.members, { hub: "dw", agent: "atlas" }] }]);
    expect(useDesk.getState().rooms.r1!.members).toContainEqual({ hub: "dw", agent: "atlas" });
    expect(posts).toEqual([{ author: "you", content: "@atlas can you look?", threadId: null }]);
    expect(sent).toEqual([{ agent: "atlas", channel: "desk:release", text: "[#release] you: @atlas can you look?" }]);
  });

  it("asks members it names without changing the room", async () => {
    await say(room, "@scout, @allan. both of you", null);
    expect(updates).toEqual([]);
    expect(sent.map((x) => x.agent)).toEqual(["scout", "allan"]);
  });

  it("asks which one when a name could be two of the crew, before keeping anything", async () => {
    await expect(say(room, "@ledger hi", null)).rejects.toThrow(/More than one of your crew is called @ledger/);
    expect(posts).toEqual([]);
    expect(sent).toEqual([]);
    await say(room, "@ledger@local hi", null);
    expect(updates).toEqual([{ members: [...room.members, { hub: "local", agent: "ledger" }] }]);
  });

  it("never lets an agent bring someone in", async () => {
    await say(room, "@allan status?", null);
    answerers.get("allan")!("ask @atlas");
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(updates).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("stops agents handing on to each other after the last hop", async () => {
    await say(room, "@allan start", null);
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const who = hop % 2 === 0 ? "allan" : "scout";
      const other = who === "allan" ? "scout" : "allan";
      answerers.get(who)!(`over to you @${other}`);
      await vi.waitFor(() => expect(posts).toHaveLength(hop + 2));
    }
    await new Promise((r) => setTimeout(r, 10));
    // Your message and one answer per hop; the last answer goes to no one.
    expect(posts).toHaveLength(MAX_HOPS + 2);
    expect(posts.at(-1)).toMatchObject({ hop: MAX_HOPS });
    expect(sent).toHaveLength(MAX_HOPS + 1);
  });
});
