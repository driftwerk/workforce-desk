import { describe, expect, it } from "vitest";
import type { MicState } from "./mic";
import { dmVoiceView, pillView, type HoldToTalk } from "./view";

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
    expect(pillView(listening, false, null, "", hold, { name: "Atlas", byName: true })).toMatchObject({
      agent: "Atlas",
      title: "Atlas has the mic",
      detail: "Voice by name is paused until you finish in the DM",
    });
    expect(pillView(listening, false, null, "", hold, { name: "Atlas", byName: false }).detail).toBe("Talking with Atlas in the DM");
    expect(pillView({ state: "downloading", model: "asr", progress: 0.5 }, false, null, "", hold, { name: "Atlas", byName: true }).title).toBe(
      "Getting voice ready",
    );
  });
});

describe("a DM's voice bar", () => {
  const mic = (patch: Partial<MicState> = {}): MicState => ({ talk: null, hold: null, pressed: false, replying: 0, problem: null, ...patch });
  const key = "local/atlas";
  const listening = { state: "listening", conversation: null } as const;

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
    expect(dmVoiceView(key, "Atlas", mic({ problem: { agent: key, message: "microphone access was denied" } }), listening, false, null, false)).toMatchObject({
      line: "microphone access was denied",
      problem: true,
    });
  });

  it("shows an answer asked by name as thinking, then speaking, in its DM", () => {
    expect(dmVoiceView(key, "Atlas", mic(), listening, true, null, false)?.line).toBe("Atlas is thinking");
    expect(dmVoiceView(key, "Atlas", mic(), { state: "speaking" }, false, key, false)?.line).toBe("Atlas is speaking");
  });
});
