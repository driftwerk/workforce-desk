import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat/types";
import type { VoiceStatus } from "./api";
import { QUIET, type MicState } from "./mic";
import { clock, dmVoiceView, lastExchange, pillView, talkView, type HoldToTalk } from "./view";

const hold: HoldToTalk = { label: "⌃⇧Space", available: true };

describe("voice pill", () => {
  it("invites a name when idle", () => {
    const v = pillView({ state: "listening", conversation: null }, false, null, "", hold);
    expect(v.title).toBe("Listening for a name");
    expect(v.detail).toBe("Say an agent's name, or hold ⌃⇧Space");
    expect(v.step).toBeNull();
  });

  it("says when hold-to-talk's keys are taken, and that a name still works", () => {
    const v = pillView({ state: "listening", conversation: null }, false, null, "", { label: "⌃⇧Space", available: false });
    expect(v.detail).toBe("Say an agent's name · ⌃⇧Space is taken by another app, change it in Settings");
  });

  it("follows a turn from name to answer", () => {
    expect(pillView({ state: "heard-name", agent: "atlas" }, false, null, "", hold)).toMatchObject({
      agent: "atlas",
      title: "atlas is listening",
      step: "heard",
    });
    expect(pillView({ state: "transcribing" }, false, "atlas", "", hold).step).toBe("transcribing");
    expect(pillView({ state: "listening", conversation: "atlas" }, true, "atlas", "what failed?", hold)).toMatchObject({
      title: "atlas is on it",
      detail: "“what failed?”",
      step: "thinking",
    });
    expect(pillView({ state: "speaking" }, false, "atlas", "", hold).title).toBe("atlas is answering");
  });

  it("shows the conversation staying open", () => {
    expect(pillView({ state: "listening", conversation: "atlas" }, false, "atlas", "", hold).detail).toBe("Say “thanks” to finish");
  });

  it("reports download progress", () => {
    const v = pillView({ state: "downloading", model: "kokoro", progress: 0.42 }, false, null, "", hold);
    expect(v.progress).toBe(0.42);
    expect(v.detail).toMatch(/^42%/);
  });

  it("shows a cloud session as live", () => {
    expect(pillView({ state: "live", agent: "atlas" }, false, null, "", hold)).toMatchObject({
      agent: "atlas",
      detail: "Live · say “thanks” to finish",
      step: null,
    });
    expect(pillView({ state: "live", agent: null }, true, "allan", "what's left?", hold)).toMatchObject({
      title: "allan is on it",
      step: "thinking",
    });
  });
});

describe("the pill while a DM has the mic", () => {
  it("names the agent, and says voice by name waits", () => {
    const listening = { state: "listening", conversation: null } as const;
    expect(pillView(listening, false, null, "", hold, { name: "Atlas", byName: true, talk: false })).toMatchObject({
      agent: "Atlas",
      title: "Atlas has the mic",
      detail: "Voice by name is paused until you finish in the DM",
    });
    expect(pillView(listening, false, null, "", hold, { name: "Atlas", byName: false, talk: false }).detail).toBe("Talking with Atlas in the DM");
    expect(pillView({ state: "downloading", model: "asr", progress: 0.5 }, false, null, "", hold, { name: "Atlas", byName: true, talk: false }).title).toBe(
      "Getting voice ready",
    );
  });

  it("leaves a spoken conversation to the title bar's pill, saying only that voice by name waits", () => {
    const listening = { state: "listening", conversation: null } as const;
    expect(pillView(listening, false, null, "", hold, { name: "Atlas", byName: true, talk: true })).toMatchObject({
      agent: null,
      title: "Voice by name is paused",
      detail: "While you talk with Atlas",
      step: null,
    });
    expect(pillView({ state: "speaking" }, false, "Atlas", "", hold, { name: "Atlas", byName: false, talk: true }).title).toBe("Voice is off");
  });
});

describe("a DM's voice bar", () => {
  const mic = (patch: Partial<MicState> = {}): MicState => ({ ...QUIET, ...patch });
  const key = "local/atlas";
  const listening = { state: "listening", conversation: null } as const;

  it("says a muted conversation is muted, until a hold is down", () => {
    expect(dmVoiceView(key, "Atlas", mic({ talk: key, muted: true }), listening, false, null, false)).toMatchObject({ line: "You’re muted", detail: "Unmute to talk again", live: true });
    expect(dmVoiceView(key, "Atlas", mic({ talk: key, muted: true, hold: key, pressed: true }), listening, false, null, false)?.line).toBe("Listening — let go to send");
  });

  it("says nothing for a DM voice has nothing to do with", () => {
    expect(dmVoiceView(key, "Atlas", mic({ talk: "local/scout" }), listening, false, null, false)).toBeNull();
  });

  it("follows a spoken conversation, saying how the agent answers", () => {
    const talking = mic({ talk: key });
    expect(dmVoiceView(key, "Atlas", talking, { state: "off" }, false, null, false)?.line).toBe("Starting the microphone…");
    expect(dmVoiceView(key, "Atlas", talking, { state: "downloading", model: "asr", progress: 0.34 }, false, null, false)).toMatchObject({
      line: "Getting voice ready",
      detail: "34% · a one-time download, kept on this computer",
    });
    expect(dmVoiceView(key, "Atlas", talking, listening, false, null, false)).toMatchObject({
      line: "Atlas is listening",
      detail: "Atlas answers aloud",
      live: true,
    });
    expect(dmVoiceView(key, "Atlas", talking, { state: "transcribing" }, false, null, true)).toMatchObject({
      line: "Transcribing…",
      detail: "Atlas answers in writing",
    });
    expect(dmVoiceView(key, "Atlas", talking, listening, true, null, false)?.line).toBe("Atlas is thinking");
    expect(dmVoiceView(key, "Atlas", talking, { state: "speaking" }, false, key, false)).toMatchObject({
      line: "Atlas is speaking",
      speaking: true,
    });
  });

  it("follows a hold from press to send", () => {
    expect(dmVoiceView(key, "Atlas", mic({ hold: key, pressed: true }), listening, false, null, false)?.line).toBe("Listening — let go to send");
    expect(dmVoiceView(key, "Atlas", mic({ hold: key }), listening, false, null, false)?.line).toBe("Transcribing…");
  });

  it("shows a DM that lent its microphone to a hold elsewhere as not live", () => {
    expect(dmVoiceView(key, "Atlas", mic({ talk: key, hold: "local/scout" }), listening, false, null, false)).toBeNull();
  });

  it("says why the microphone couldn't be had", () => {
    expect(dmVoiceView(key, "Atlas", mic({ problem: { agent: key, mode: "hold", message: "microphone access was denied" } }), listening, false, null, false)).toMatchObject({
      line: "microphone access was denied",
      problem: true,
    });
  });

  it("shows an answer asked by name as thinking, then speaking, in its DM", () => {
    expect(dmVoiceView(key, "Atlas", mic(), listening, true, null, false)?.line).toBe("Atlas is thinking");
    expect(dmVoiceView(key, "Atlas", mic(), { state: "speaking" }, false, key, false)?.line).toBe("Atlas is speaking");
  });
});

describe("the title bar's pill", () => {
  const key = "local/atlas";
  const mic = (patch: Partial<MicState> = {}): MicState => ({ ...QUIET, talk: key, since: 0, ...patch });
  const listening = { state: "listening", conversation: null } as const;
  const line = (m: MicState, status: VoiceStatus = listening, waiting = false, speakingFor: string | null = null) => talkView(m, status, waiting, speakingFor, false)?.line;

  it("shows nothing without a conversation or a problem", () => {
    expect(talkView(QUIET, listening, false, null, false)).toBeNull();
  });

  it("listens, with how long it has gone on", () => {
    expect(talkView(mic(), listening, false, null, false)).toEqual({ agent: key, tone: "live", line: "Listening", elapsed: true, speaking: false });
  });

  it("follows the engine and the agent, a reply first", () => {
    expect(talkView(mic(), { state: "downloading", model: "asr", progress: 0.4 }, false, null, false)).toMatchObject({ tone: "busy", line: "Getting voice ready · 40%" });
    expect(line(mic(), { state: "off" })).toBe("Starting…");
    expect(talkView(mic(), { state: "speaking" }, true, key, false)).toMatchObject({ tone: "live", line: "Speaking", speaking: true });
    expect(line(mic(), { state: "speaking" }, false, "local/scout")).toBe("Listening");
    expect(talkView(mic(), listening, true, null, false)).toMatchObject({ tone: "busy", line: "Thinking…", elapsed: false });
    expect(line(mic(), { state: "transcribing" })).toBe("Transcribing…");
  });

  it("follows its own hold, and a hold elsewhere pauses it", () => {
    expect(line(mic({ hold: key, pressed: true }), listening, true)).toBe("Listening — let go to send");
    expect(line(mic({ hold: key }))).toBe("Transcribing…");
    expect(talkView(mic({ hold: "local/scout", pressed: true }), listening, false, null, false)).toMatchObject({ tone: "muted", line: "Paused" });
  });

  it("says when it's muted", () => {
    expect(talkView(mic({ muted: true }), listening, false, null, false)).toMatchObject({ tone: "muted", line: "Muted — tap to talk", elapsed: false });
    expect(line(mic({ muted: true }), listening, true)).toBe("Thinking…");
  });

  it("says the microphone couldn't be had, blocked or otherwise, before anything else", () => {
    const failed = mic({ talk: null, problem: { agent: key, mode: "talk", message: "no input device" } });
    expect(talkView(failed, listening, false, null, false)).toEqual({ agent: key, tone: "problem", line: "Microphone problem — fix", elapsed: false, speaking: false });
    expect(talkView(failed, listening, false, null, true)?.line).toBe("Microphone blocked — fix");
    expect(talkView(mic({ talk: null, problem: { agent: key, mode: "hold", message: "no input device" } }), listening, false, null, false)).toBeNull();
  });
});

describe("a clock", () => {
  it("counts minutes and seconds", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(134_900)).toBe("2:14");
    expect(clock(3_725_000)).toBe("62:05");
    expect(clock(-5)).toBe("0:00");
  });
});

describe("the last exchange", () => {
  const at = (s: number) => new Date(s * 1000).toISOString();
  const msg = (id: string, role: ChatMessage["role"], content: string, s: number, status: ChatMessage["status"] = "complete"): ChatMessage => ({ id, role, content, at: at(s), status, tools: [] });

  it("is what you said last since it began, and the agent's answer after it", () => {
    const messages = [
      msg("1", "user", "before", 5),
      msg("2", "assistant", "old answer", 6),
      msg("3", "user", "check my inbox", 20),
      msg("4", "assistant", "Two new since nine.", 21),
      msg("5", "assistant", "One's from James.", 22),
    ];
    expect(lastExchange(messages, 10_000)).toEqual({ you: "check my inbox", agent: "One's from James." });
    expect(lastExchange([...messages, msg("6", "user", "summarise it", 30)], 10_000)).toEqual({ you: "summarise it", agent: null });
  });

  it("is nothing from before it began, and leaves out failures", () => {
    expect(lastExchange([msg("1", "user", "before", 5)], 10_000)).toEqual({ you: null, agent: null });
    expect(lastExchange([msg("1", "user", "hi", 20), msg("2", "assistant", "couldn't", 21, "error")], 10_000)).toEqual({ you: "hi", agent: null });
    expect(lastExchange([msg("1", "assistant", "Hello", 20)], 10_000)).toEqual({ you: null, agent: null });
  });

  it("takes the agent's answer whatever its hub's clock says", () => {
    expect(lastExchange([msg("1", "user", "hi", 20), msg("2", "assistant", "Hello", 2)], 10_000)).toEqual({ you: "hi", agent: "Hello" });
  });
});
