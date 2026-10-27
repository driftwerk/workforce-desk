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

beforeEach(() => {
  sent.length = 0;
  posts.length = 0;
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
    ],
  });
  useDesk.setState({
    rooms: { r1: room },
    hub: { post: async (_id: string, m: unknown) => (posts.push(m), m) } as never,
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
});
