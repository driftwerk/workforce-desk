import { describe, expect, it } from "vitest";
import { pillView } from "./view";

describe("voice pill", () => {
  it("invites a name when idle", () => {
    const v = pillView({ state: "listening", conversation: null }, false, null, "");
    expect(v.title).toBe("Listening for a name");
    expect(v.detail).toContain("⌥⌘Space");
    expect(v.step).toBeNull();
  });

  it("follows a turn from name to answer", () => {
    expect(pillView({ state: "heard-name", agent: "atlas" }, false, null, "")).toMatchObject({
      agent: "atlas",
      title: "atlas is listening",
      step: "heard",
    });
    expect(pillView({ state: "transcribing" }, false, "atlas", "").step).toBe("transcribing");
    expect(pillView({ state: "listening", conversation: "atlas" }, true, "atlas", "what failed?")).toMatchObject({
      title: "atlas is on it",
      detail: "“what failed?”",
      step: "thinking",
    });
    expect(pillView({ state: "speaking" }, false, "atlas", "").title).toBe("atlas is answering");
  });

  it("shows the conversation staying open", () => {
    expect(pillView({ state: "listening", conversation: "atlas" }, false, "atlas", "").detail).toBe("Say “thanks” to finish");
  });

  it("reports download progress", () => {
    const v = pillView({ state: "downloading", model: "kokoro", progress: 0.42 }, false, null, "");
    expect(v.progress).toBe(0.42);
    expect(v.detail).toMatch(/^42%/);
  });

  it("shows a cloud session as live", () => {
    expect(pillView({ state: "live", agent: "atlas" }, false, null, "")).toMatchObject({
      agent: "atlas",
      detail: "Live · say “thanks” to finish",
      step: null,
    });
    expect(pillView({ state: "live", agent: null }, true, "allan", "what's left?")).toMatchObject({
      title: "allan is on it",
      step: "thinking",
    });
  });
});
