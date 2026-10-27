import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../settings/store";
import { VOICE_ENGINES, voiceEngine } from "./engines";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

describe("voice engines", () => {
  it("fall back to the on-device cascade for anything unknown", () => {
    expect(voiceEngine("gemini-live").cloud).toBe(true);
    expect(voiceEngine("dessa").id).toBe("cascade");
    expect(voiceEngine(undefined).id).toBe("cascade");
  });

  it("say where speech goes", () => {
    expect(voiceEngine("cascade").privacy).toContain("on this Mac");
    expect(voiceEngine("gpt-live").privacy).toContain("OpenAI");
    expect(voiceEngine("gemini-live").privacy).toContain("Google");
    expect(new Set(VOICE_ENGINES.map((e) => e.id)).size).toBe(VOICE_ENGINES.length);
  });

  it("are saved with the rest of Desk's settings", () => {
    useSettings.setState({ loaded: true });
    useSettings.getState().set({ voiceEngine: "gpt-live" });
    const saved = vi.mocked(invoke).mock.calls.filter(([c]) => c === "settings_save").at(-1);
    expect(saved?.[1]).toMatchObject({ settings: { voiceEngine: "gpt-live" } });
  });
});
