import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emptyConversation, type ConversationState } from "../chat/conversation";
import { useChat } from "../chat/store";
import { useSettings } from "../settings/store";
import type { Agent, ChatMessage } from "../chat/types";
import { Turns } from "./useVoice";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(), unregister: vi.fn() }));

const atlas: Agent = { hubId: "local", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false };
const key = "local/atlas";

const answer = (content: string): ConversationState => ({
  ...emptyConversation(),
  connected: true,
  messages: [{ id: "a1", role: "assistant", content, status: "complete", at: "", tools: [] } satisfies ChatMessage],
});

const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === command);

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockClear();
  useChat.setState({
    roster: [atlas],
    activeAgent: null,
    conversations: { [key]: { ...emptyConversation(), connected: true } },
    openDm: vi.fn(),
    send: vi.fn(() => true),
  });
});

afterEach(() => vi.useRealTimers());

const fish = { provider: "fish_audio", voice: "802e3bc2b27e49c2995d23ef70e6ac89" };
const heart = { provider: "kokoro", voice: "af_heart" };

describe("spoken turns", () => {
  it("hands a cloud model's request to the agent and its answer back as a tool result", () => {
    const turns = new Turns();
    turns.heard({ agent: "Atlas", text: "what failed overnight?", callId: "fc-1" });
    expect(useChat.getState().send).toHaveBeenCalledWith(key, "what failed overnight?");
    vi.advanceTimersByTime(3_000);
    expect(calls("voice_speak")).toHaveLength(0);
    useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: answer("**Two** tests failed.") } }));
    expect(calls("voice_tool_result")).toEqual([["voice_tool_result", { callId: "fc-1", text: "Two tests failed." }]]);
    expect(calls("voice_speak")).toHaveLength(0);
  });

  it("reads the cascade's answers aloud, with an acknowledgement when slow", () => {
    const turns = new Turns();
    turns.heard({ agent: "Atlas", text: "what failed overnight?" });
    vi.advanceTimersByTime(2_100);
    expect(calls("voice_speak")).toEqual([["voice_speak", { text: "On it.", more: true, voice: fish }]]);
    useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: answer("Two tests failed.") } }));
    expect(calls("voice_speak").at(-1)).toEqual(["voice_speak", { text: "Two tests failed.", more: false, voice: fish }]);
    expect(calls("voice_tool_result")).toHaveLength(0);
  });

  it("tells the model when it named someone who isn't there", () => {
    new Turns().heard({ agent: "Scout", text: "run it", callId: "fc-2" });
    expect(calls("voice_tool_result")).toEqual([
      ["voice_tool_result", { callId: "fc-2", text: "There's no agent called Scout. The agents are Atlas." }],
    ]);
    expect(useChat.getState().send).not.toHaveBeenCalled();
  });

  it("reads an agent's answer in its own voice", () => {
    useSettings.setState({ agentVoices: { [key]: heart } });
    new Turns().heard({ agent: "Atlas", text: "status?" });
    useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: answer("All green.") } }));
    expect(calls("voice_speak").at(-1)).toEqual(["voice_speak", { text: "All green.", more: false, voice: heart }]);
  });
});
