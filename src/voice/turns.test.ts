import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emptyConversation, reduce, type ConversationState } from "../chat/conversation";
import { useChat } from "../chat/store";
import { useSettings } from "../settings/store";
import { FEATURES, type Agent, type ChatMessage, type ServerMessage } from "../chat/types";
import { claimMode, useMic } from "./mic";
import { useVoiceStore } from "./store";
import { endConversation, talkOrEnd, Turns } from "./useVoice";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(), unregister: vi.fn() }));

const atlas: Agent = { hubId: "local", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false };
const key = "local/atlas";

const answer = (content: string): ConversationState => ({
  ...emptyConversation(),
  connected: true,
  messages: [{ id: "a1", role: "assistant", content, status: "complete", at: "", tools: [] } satisfies ChatMessage],
});

/** Turns that stop waiting when the test ends. */
const made: Turns[] = [];
const fresh = (): Turns => {
  const turns = new Turns();
  made.push(turns);
  return turns;
};

const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === command);

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockClear();
  useMic.setState({ talk: null, hold: null, pressed: false, replying: 0, problem: null });
  useSettings.setState({ agentVoices: {}, writtenReplies: [], voiceEngine: "cascade" });
  useVoiceStore.setState({ waiting: {}, speakingFor: null, thinking: false });
  useChat.setState({
    roster: [atlas],
    activeAgent: null,
    conversations: { [key]: { ...emptyConversation(), connected: true } },
    openDm: vi.fn(),
    send: vi.fn(() => true),
  });
});

afterEach(() => {
  made.splice(0).forEach((turns) => turns.stop());
  vi.useRealTimers();
});

const fish = { provider: "fish_audio", voice: "802e3bc2b27e49c2995d23ef70e6ac89" };
const heart = { provider: "kokoro", voice: "af_heart" };

describe("spoken turns", () => {
  it("hands a cloud model's request to the agent and its answer back as a tool result", () => {
    useSettings.setState({ voiceEngine: "gpt-live" });
    const turns = fresh();
    turns.heard({ agent: "Atlas", text: "what failed overnight?", callId: "fc-1" });
    expect(useChat.getState().send).toHaveBeenCalledWith(key, "what failed overnight?", {
      voice: { reply: "spoken", speech: { provider: "gpt-live" } },
    });
    vi.advanceTimersByTime(3_000);
    expect(calls("voice_speak")).toHaveLength(0);
    useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: answer("**Two** tests failed.") } }));
    expect(calls("voice_tool_result")).toEqual([["voice_tool_result", { callId: "fc-1", text: "Two tests failed." }]]);
    expect(calls("voice_speak")).toHaveLength(0);
  });

  it("reads the cascade's answers aloud, and says nothing before them", () => {
    const turns = fresh();
    turns.heard({ agent: "Atlas", text: "what failed overnight?" });
    expect(useChat.getState().send).toHaveBeenCalledWith(key, "what failed overnight?", {
      voice: { reply: "spoken", speech: { provider: "fish_audio" } },
    });
    expect(useVoiceStore.getState().waiting).toEqual({ [key]: true });
    vi.advanceTimersByTime(60_000);
    expect(calls("voice_speak")).toHaveLength(0);
    useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: answer("Two tests failed.") } }));
    expect(calls("voice_speak")).toEqual([["voice_speak", { text: "Two tests failed.", voice: fish }]]);
    expect(calls("voice_tool_result")).toHaveLength(0);
    expect(useVoiceStore.getState()).toMatchObject({ waiting: {}, speakingFor: key, thinking: false });
  });

  it("tells the model when it named someone who isn't there", () => {
    fresh().heard({ agent: "Scout", text: "run it", callId: "fc-2" });
    expect(calls("voice_tool_result")).toEqual([
      ["voice_tool_result", { callId: "fc-2", text: "There's no agent called Scout. The agents are Atlas." }],
    ]);
    expect(useChat.getState().send).not.toHaveBeenCalled();
  });

  it("reads an agent's answer in its own voice", () => {
    useSettings.setState({ agentVoices: { [key]: heart } });
    fresh().heard({ agent: "Atlas", text: "status?" });
    useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: answer("All green.") } }));
    expect(calls("voice_speak").at(-1)).toEqual(["voice_speak", { text: "All green.", voice: heart }]);
  });

  it("tells the hub the voice an answer is read in, model and all", () => {
    useSettings.setState({ agentVoices: { [key]: { provider: "fish_audio", model: "s1", voice: "v" } } });
    fresh().heard({ agent: "Atlas", text: "status?" });
    expect(useChat.getState().send).toHaveBeenCalledWith(key, "status?", {
      voice: { reply: "spoken", speech: { provider: "fish_audio", model: "s1" } },
    });
  });
});

describe("spoken turns in a DM with the microphone", () => {
  const scout: Agent = { hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false };
  const scoutKey = "local/scout";

  let turns: Turns;
  beforeEach(() => {
    turns = fresh();
    useChat.setState((s) => ({
      roster: [atlas, scout],
      conversations: { ...s.conversations, [scoutKey]: { ...emptyConversation(), connected: true } },
    }));
  });
  afterEach(() => turns.stop());

  it("go to the DM talking, whatever name they open with, without opening anything", () => {
    useMic.setState({ talk: scoutKey });
    turns.heard({ agent: "Atlas", text: "Atlas, what about yours?" });
    expect(useChat.getState().send).toHaveBeenCalledWith(scoutKey, "Atlas, what about yours?", {
      voice: { reply: "spoken", speech: { provider: "fish_audio" } },
    });
    expect(useChat.getState().openDm).not.toHaveBeenCalled();
  });

  it("go to the DM holding to talk, which then gives the microphone back", () => {
    useMic.setState({ talk: scoutKey, hold: key, pressed: false });
    turns.heard({ agent: null, text: "and the build?" });
    expect(useChat.getState().send).toHaveBeenCalledWith(key, "and the build?", expect.anything());
    expect(useMic.getState()).toMatchObject({ hold: null, talk: scoutKey });
  });

  it("are answered in writing when the DM says so: sent as dictated, never read aloud", () => {
    useMic.setState({ talk: scoutKey });
    useSettings.setState({ writtenReplies: [scoutKey] });
    turns.heard({ agent: null, text: "note the release date" });
    expect(useChat.getState().send).toHaveBeenCalledWith(scoutKey, "note the release date", { voice: { reply: "written" } });
    useChat.setState((s) => ({ conversations: { ...s.conversations, [scoutKey]: answer("Noted: the 14th.") } }));
    expect(calls("voice_speak")).toHaveLength(0);
    expect(useVoiceStore.getState().waiting).toEqual({});
  });
});

/** A hub that says when turns end, sending these frames. */
const frames = (...sent: ServerMessage[]) => {
  for (const frame of sent)
    useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: reduce(s.conversations[key]!, frame) } }));
};
const streamed = (ref: string, text: string, speech?: string): ServerMessage[] => [
  { type: "stream_start", turn_ref: ref },
  { type: "stream_delta", turn_ref: ref, content: text, ...(speech ? { speech } : {}) },
  { type: "stream_end", turn_ref: ref },
];

describe("a spoken answer on a hub that says when turns end", () => {
  /** The turn the next thing said gets, once the store has sent it. */
  const sendsTurn = (ref: string) =>
    useChat.setState({
      send: vi.fn(() => {
        useChat.setState((s) => {
          const c = s.conversations[key]!;
          const turn = { ref, replyId: null, text: "", working: null, tools: [], attachments: [], state: "live" as const, acked: false };
          return { conversations: { ...s.conversations, [key]: { ...c, turns: { ...c.turns, [ref]: turn } } } };
        });
        return true;
      }),
    });

  beforeEach(() => {
    useChat.setState({
      conversations: { [key]: { ...emptyConversation(), connected: true, features: new Set([FEATURES.stream, FEATURES.place]) } },
    });
    sendsTurn("t1");
  });

  it("says a line before a tool and the answer after it, not just the first", () => {
    const turns = fresh();
    turns.heard({ agent: "Atlas", text: "what failed?" });
    frames(...streamed("t1", "Let me check."));
    expect(calls("voice_speak").map(([, a]) => (a as { text: string }).text)).toEqual(["Let me check."]);
    expect(useVoiceStore.getState().waiting).toEqual({ [key]: true });
    frames({ type: "tool_start", turn_ref: "t1", content: "logs" }, { type: "tool_end", turn_ref: "t1", content: "logs" });
    frames(...streamed("t1", "Two tests failed."));
    expect(calls("voice_speak").map(([, a]) => (a as { text: string }).text)).toEqual(["Let me check.", "Two tests failed."]);
    frames({ type: "turn_end", turn_ref: "t1" });
    expect(useVoiceStore.getState().waiting).toEqual({});
    frames(...streamed("other", "Something later."));
    expect(calls("voice_speak")).toHaveLength(2);
  });

  it("says what the voice is to say, and shows what's to be shown", () => {
    fresh().heard({ agent: "Atlas", text: "what failed?" });
    frames(...streamed("t1", "Found it.", "(excited) Found it."));
    expect(calls("voice_speak")[0]![1]).toMatchObject({ text: "(excited) Found it." });
    expect(useChat.getState().conversations[key]!.messages.at(-1)!.content).toBe("Found it.");
  });

  it("hands a voice model all of the turn's answer, once, at its end", () => {
    useSettings.setState({ voiceEngine: "gpt-live" });
    fresh().heard({ agent: "Atlas", text: "what failed?", callId: "fc-1" });
    frames(...streamed("t1", "Let me check."));
    expect(calls("voice_tool_result")).toHaveLength(0);
    frames(...streamed("t1", "Two tests failed."), { type: "turn_end", turn_ref: "t1" });
    expect(calls("voice_tool_result")).toEqual([["voice_tool_result", { callId: "fc-1", text: "Let me check. Two tests failed." }]]);
    expect(calls("voice_speak")).toHaveLength(0);
  });

  it("stops waiting when a turn ends with no answer", () => {
    fresh().heard({ agent: "Atlas", text: "stop that" });
    frames({ type: "turn_end", turn_ref: "t1" });
    expect(useVoiceStore.getState().waiting).toEqual({});
    expect(calls("voice_speak")).toHaveLength(0);
  });

  it("says nothing more of an answer once it's been stopped", () => {
    const turns = fresh();
    turns.heard({ agent: "Atlas", text: "what failed?" });
    frames(...streamed("t1", "Let me check."));
    turns.stopped();
    frames(...streamed("t1", "Two tests failed."));
    expect(calls("voice_speak")).toHaveLength(1);
  });

  it("speaks up again when something is said after that", () => {
    const turns = fresh();
    turns.heard({ agent: "Atlas", text: "what failed?" });
    turns.stopped();
    sendsTurn("t2");
    turns.heard({ agent: "Atlas", text: "actually, which one?" });
    frames({ type: "injected" }, ...streamed("t1", "The first."));
    expect(calls("voice_speak").map(([, a]) => (a as { text: string }).text)).toEqual(["The first."]);
  });

  it("goes on to say the live turn's answer to what was absorbed into it", () => {
    const turns = fresh();
    turns.heard({ agent: "Atlas", text: "what failed?" });
    frames({ type: "stream_start", turn_ref: "t1" });
    sendsTurn("t2");
    turns.heard({ agent: "Atlas", text: "and yesterday?" });
    frames({ type: "injected" }, { type: "stream_delta", turn_ref: "t1", content: "Both days." }, { type: "stream_end", turn_ref: "t1" });
    expect(calls("voice_speak").map(([, a]) => (a as { text: string }).text)).toEqual(["Both days."]);
    frames({ type: "turn_end", turn_ref: "t1" });
    expect(useVoiceStore.getState().waiting).toEqual({});
  });

  it("doesn't read out history brought in while it waits", () => {
    fresh().heard({ agent: "Atlas", text: "what failed?" });
    useChat.setState((s) => {
      const c = s.conversations[key]!;
      const old: ChatMessage = { id: "h", role: "assistant", content: "Last week.", status: "complete", at: "2020-01-01T00:00:00Z", tools: [] };
      return { conversations: { ...s.conversations, [key]: { ...c, messages: [old, ...c.messages] } } };
    });
    expect(calls("voice_speak")).toHaveLength(0);
  });
});

describe("the engine that says a DM's answer", () => {
  beforeEach(() => {
    useChat.setState({
      conversations: { [key]: { ...emptyConversation(), connected: true } },
    });
  });

  const speaking = (turns: Turns) => turns.status({ state: "speaking" });
  const listening = (turns: Turns) => turns.status({ state: "listening", conversation: null });
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it("stays up from a hold until the answer has been said, not while it's thought about", async () => {
    const turns = fresh();
    useMic.setState({ hold: key, pressed: false });
    turns.heard({ agent: null, text: "what failed?" });
    expect(claimMode()).toBeNull();
    useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: answer("Two tests.") } }));
    expect(claimMode()).toBe("held");
    await flush();
    speaking(turns);
    expect(claimMode()).toBe("held");
    listening(turns);
    expect(claimMode()).toBeNull();
  });

  it("isn't let go by a status from before the answer started", async () => {
    const turns = fresh();
    useMic.setState({ talk: key });
    turns.heard({ agent: null, text: "what failed?" });
    useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: answer("Two tests.") } }));
    useMic.setState({ talk: null });
    listening(turns);
    expect(claimMode()).toBe("held");
    await flush();
    speaking(turns);
    listening(turns);
    expect(claimMode()).toBeNull();
  });

  it("isn't held for an answer read out by name", () => {
    fresh().heard({ agent: "Atlas", text: "what failed?" });
    useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: answer("Two tests.") } }));
    expect(claimMode()).toBeNull();
    expect(calls("voice_speak")).toHaveLength(1);
  });

  it("lets go when there's nothing to say it with, and says so", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      command === "voice_speak" ? Promise.reject(new Error("Voice isn't running.")) : Promise.resolve(),
    );
    useMic.setState({ talk: key });
    fresh().heard({ agent: null, text: "what failed?" });
    useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: answer("Two tests.") } }));
    await flush();
    vi.mocked(invoke).mockImplementation(() => Promise.resolve());
    expect(useMic.getState().replying).toBe(0);
    expect(useVoiceStore.getState().error).toBe("Voice isn't running.");
  });

  it("ending the conversation stops it, and what's left isn't said", () => {
    const turns = fresh();
    useMic.setState({ talk: key });
    turns.heard({ agent: null, text: "what failed?" });
    endConversation(key);
    expect(useMic.getState().talk).toBeNull();
    expect(calls("voice_stop_speaking")).toHaveLength(1);
    useChat.setState((s) => ({ conversations: { ...s.conversations, [key]: answer("Two tests.") } }));
    expect(calls("voice_speak")).toHaveLength(0);
  });

  it("the talk button starts a conversation, and ends one", () => {
    talkOrEnd(key);
    expect(useMic.getState().talk).toBe(key);
    expect(calls("voice_stop_speaking")).toHaveLength(0);
    talkOrEnd(key);
    expect(useMic.getState().talk).toBeNull();
    expect(calls("voice_stop_speaking")).toHaveLength(1);
  });
});
