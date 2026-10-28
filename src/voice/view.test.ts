import { describe, expect, it } from "vitest";
import { pillView, type HoldToTalk } from "./view";

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
