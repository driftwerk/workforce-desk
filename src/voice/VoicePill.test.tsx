import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../settings/store";
import { useShortcuts } from "../shortcuts/manager";
import { useVoiceStore } from "./store";
import { VoicePill } from "./VoicePill";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

afterEach(cleanup);

describe("VoicePill", () => {
  it("shows the turn's progress and the transcript", () => {
    act(() =>
      useVoiceStore.setState({
        status: { state: "listening", conversation: "atlas" },
        thinking: true,
        heardBy: "atlas",
        transcript: "what failed overnight?",
        error: null,
      }),
    );
    render(<VoicePill />);
    expect(screen.getByText("atlas is on it")).toBeTruthy();
    expect(screen.getByText("“what failed overnight?”")).toBeTruthy();
    expect(screen.getByText("Thinking").className).toBe("now");
    expect(screen.getByText("Heard name").className).toBe("done");
  });

  it("offers to stop speaking, and the mic toggles the voice setting", () => {
    act(() => useVoiceStore.setState({ status: { state: "speaking" }, thinking: false, heardBy: null, transcript: "" }));
    render(<VoicePill />);
    expect(screen.getByLabelText("Stop speaking")).toBeTruthy();
    const mic = screen.getByLabelText("Turn voice on");
    fireEvent.click(mic);
    expect(useSettings.getState().voice).toBe(true);
  });

  it("shows an error in place of the hint", () => {
    act(() => useVoiceStore.setState({ status: { state: "off" }, error: "microphone access was denied" }));
    render(<VoicePill />);
    expect(screen.getByText("microphone access was denied").className).toContain("voice-error");
  });

  it("shows the configured hold-to-talk keys, and says when another app has them", () => {
    act(() => {
      useSettings.getState().setShortcut("pushToTalk", "Control+Alt+K");
      useVoiceStore.setState({ status: { state: "listening", conversation: null }, thinking: false, heardBy: null, transcript: "", error: null });
    });
    render(<VoicePill />);
    expect(screen.getByText("Say an agent's name, or hold ⌃⌥K")).toBeTruthy();
    act(() =>
      useShortcuts.setState({
        status: { pushToTalk: { state: "taken", message: "Hold to talk can’t use ⌃⌥K: another app already has it — choose other keys" }, ask: { state: "off" } },
      }),
    );
    expect(screen.getByText("Say an agent's name · ⌃⌥K is taken by another app, change it in Settings")).toBeTruthy();
  });

  it("asks to be allowed the microphone, with the setting, and starts again once it is", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const calls = vi.mocked(invoke);
    calls.mockClear();
    let access = "denied";
    calls.mockImplementation(((cmd: string) => Promise.resolve(cmd === "privacy_check" ? access : undefined)) as typeof invoke);
    act(() => {
      useSettings.setState({ voice: true });
      useVoiceStore.setState({ status: { state: "off" }, error: "starting audio: Desk isn’t allowed to use the microphone." });
    });
    render(<VoicePill />);
    expect(screen.getByText("Allow Desk to use the microphone.")).toBeTruthy();
    // The raw text only under Details.
    expect(document.querySelector(".voice-detail")?.textContent).not.toContain("starting audio");
    fireEvent.click(screen.getByRole("button", { name: "Open Microphone settings" }));
    expect(calls).toHaveBeenCalledWith("privacy_open", { pane: "microphone" });
    // Still not allowed: the problem stays.
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(screen.getByText("Allow Desk to use the microphone.")).toBeTruthy();
    // Allowed, and Desk back in front: voice starts again and the problem goes.
    access = "granted";
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await vi.waitFor(() => expect(useVoiceStore.getState().error).toBeNull());
    expect(calls.mock.calls.some(([cmd]) => cmd === "voice_enable")).toBe(true);
    expect(screen.queryByText("Allow Desk to use the microphone.")).toBeNull();
  });
});
