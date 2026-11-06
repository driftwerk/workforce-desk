import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyConversation, type ConversationState } from "./conversation";
import { useChat } from "./store";
import { FEATURES, type ChatMessage, type HubAccount } from "./types";
import { setDevToken } from "../hub/devTokens";

/** The DMs opened, to tell what they hear and see what they drop. */
const opened = vi.hoisted(() => [] as { change: (s: ConversationState) => void; dropped: Set<string>[] }[]);

vi.mock("./conversation", async (original) => ({
  ...(await original<typeof import("./conversation")>()),
  Conversation: class {
    dropped: Set<string>[] = [];
    constructor(_hub: unknown, _agent: unknown, readonly change: (s: ConversationState) => void) {
      opened.push(this);
    }
    send() {
      return { turnRef: "t1" };
    }
    forget() {}
    drop(ids: Set<string>) {
      this.dropped.push(ids);
    }
    place() {}
    cancel() {}
    close() {}
  },
}));

const hub: HubAccount = { id: "local", label: "This computer", url: "http://127.0.0.1:4100", local: true, revision: "tok" };
setDevToken("local", "tok");
const agent = { hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false };
const key = "local/scout";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
let page: unknown[] = [];

const said = (clientId?: string): ChatMessage => ({
  id: "m-1",
  role: "user",
  content: "status?",
  at: new Date().toISOString(),
  status: "complete",
  tools: [],
  ...(clientId ? { clientId } : {}),
});

/** What the DM drops of `live` once the hub's page reads `kept`. */
const droppedOn = async (features: string[], live: ChatMessage[], kept: unknown[]): Promise<string[]> => {
  page = [];
  useChat.getState().openDm(key);
  await vi.waitFor(() => expect(useChat.getState().histories[key]?.state).toBe("ready"));
  const dm = opened.at(-1)!;
  dm.change({ ...emptyConversation(), connected: true, features: new Set(features), messages: live });
  page = kept;
  await useChat.getState().refreshHistory(key);
  return dm.dropped.flatMap((ids) => [...ids]);
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ messages: page, more: false })),
  );
  useChat.setState({ hubs: [hub], roster: [agent], conversations: {}, histories: {}, activeAgent: null });
});
afterEach(() => {
  useChat.getState().forget(key);
  vi.unstubAllGlobals();
});

describe("which live messages a DM's read settles", () => {
  it("on an older hub, still by what they say: its rows name no client id", async () => {
    const kept = [{ id: "h1", from: "user", text: "status?", at: new Date().toISOString() }];
    expect(await droppedOn([FEATURES.place, FEATURES.stream], [said()], kept)).toEqual(["m-1"]);
  });

  it("on a hub with client ids, by that id alone", async () => {
    const features = [FEATURES.place, FEATURES.stream, FEATURES.clientIds];
    const other = [{ id: "h1", from: "user", text: "status?", client_id: "another", seq: 1 }];
    expect(await droppedOn(features, [said("c1")], other)).toEqual([]);
    useChat.getState().forget(key);
    const its = [{ id: "h1", from: "user", text: "status (redacted)", client_id: "c1", seq: 1 }];
    expect(await droppedOn(features, [said("c1")], its)).toEqual(["m-1"]);
  });
});
