import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { FEATURES, type Agent, type HubAccount } from "../chat/types";
import { setDevToken } from "../hub/devTokens";
import { FakeSocket } from "../testing/sockets";
import { useSettings } from "../settings/store";
import { owner, QUIET, useMic } from "./mic";
import { useVoiceStore } from "./store";
import { endConversation, talkOrEnd, Turns } from "./useVoice";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(), unregister: vi.fn() }));

// What's said to an agent by name reaches its DM through the real chat
// store, whether or not a spoken conversation with another agent came first.

const local: HubAccount = { id: "local", label: "This computer", url: "http://127.0.0.1:9", local: true, revision: "t" };
const agent = (id: string, name: string): Agent => ({ hubId: "local", id, name, model: null, provider: null, isDefault: false });
const desk = agent("desk", "Desk");
const kat = agent("kat", "Kat");
const features = [FEATURES.place, FEATURES.stream, FEATURES.queue, FEATURES.clientIds];

let turns: Turns;

const connect = async (id: string) => {
  const socket = FakeSocket.find("/ws", id)!;
  await Promise.resolve();
  socket.receive({ type: "connected", session_id: `s-${id}`, features });
  return socket;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.reset();
  setDevToken("local", "tok");
  useMic.setState(QUIET);
  useSettings.setState({
    agentVoices: { "local/kat": { provider: "fish_audio", model: "s2.1-pro", voice: "v" } },
    writtenReplies: [],
    voiceEngine: "cascade",
  });
  useVoiceStore.setState({ waiting: {}, speakingFor: null, thinking: false, error: null });
  useChat.setState({ hubs: [local], roster: [desk, kat], activeAgent: null, panelAgent: "local/kat" });
  turns = new Turns();
});

afterEach(() => {
  turns.stop();
  ["local/desk", "local/kat"].forEach((key) => useChat.getState().forget(key));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("an utterance addressed by name", () => {
  it("is sent to that agent's DM when no conversation came before", async () => {
    turns.heard({ agent: "Kat", text: "How are you?" });
    const socket = await connect("kat");
    await vi.advanceTimersByTimeAsync(150);
    expect(socket.chats.map((c) => [c.content, (c.desk as { voice?: unknown }).voice])).toEqual([
      ["How are you?", { reply: "spoken", speech: { provider: "fish_audio", model: "s2.1-pro" } }],
    ]);
    expect(useChat.getState().activeAgent).toBe("local/kat");
  });

  it("is sent to that agent, not the one a conversation just ended with", async () => {
    talkOrEnd("local/desk");
    turns.heard({ agent: null, text: "Keep me informed" });
    const deskSocket = await connect("desk");
    await vi.advanceTimersByTimeAsync(150);
    expect(deskSocket.chats.map((c) => c.content)).toEqual(["Keep me informed"]);
    endConversation("local/desk");
    expect(owner()).toBeNull();
    turns.heard({ agent: "Kat", text: "How are you?" });
    const katSocket = await connect("kat");
    await vi.advanceTimersByTimeAsync(150);
    expect(katSocket.chats.map((c) => c.content)).toEqual(["How are you?"]);
    expect(deskSocket.chats.map((c) => c.content)).toEqual(["Keep me informed"]);
  });
});
