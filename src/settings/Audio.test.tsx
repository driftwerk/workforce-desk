import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "../platform";
import { useHost, DEFAULT_HOST } from "../shell/host";
import { AudioSettings, deviceEntries, meterFill } from "./Audio";
import { DEFAULT_AUDIO, useSettings } from "./store";

vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  invoke: vi.fn(),
  saveSettings: vi.fn(() => Promise.resolve()),
}));

const DEVICES = {
  inputs: [
    { id: "lg", name: "LG UltraFine Display Audio", isDefault: true },
    { id: "yeti", name: "Yeti Stereo Microphone", isDefault: false },
  ],
  outputs: [{ id: "speakers", name: "MacBook Pro Speakers", isDefault: true }],
};

const NOW = {
  listening: true,
  input: DEVICES.inputs[0],
  output: DEVICES.outputs[0],
  echoCancelled: true,
  quietWhileSpeaking: false,
  notes: [] as string[],
  level: 0.03,
};

let tested: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useHost.setState(DEFAULT_HOST);
  useSettings.setState({ loaded: true, audio: DEFAULT_AUDIO });
  vi.mocked(invoke).mockImplementation(((cmd: string) => {
    if (cmd === "voice_audio_devices") return Promise.resolve(DEVICES);
    if (cmd === "voice_audio_status") return Promise.resolve(NOW);
    if (cmd === "voice_audio_test") return new Promise<void>((done) => (tested = done));
    return Promise.resolve(undefined);
  }) as typeof invoke);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const show = async () => {
  render(<AudioSettings />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
};

it("offers the system's microphone by name and every other, and keeps the one chosen", async () => {
  await show();
  fireEvent.click(screen.getByRole("button", { name: /^Microphone: Same as system \(LG UltraFine Display Audio\)/ }));
  const yeti = screen.getByRole("menuitemradio", { name: /Yeti Stereo Microphone/ });
  expect(screen.getByRole("menuitemradio", { name: /Same as system/ }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(yeti);
  expect(useSettings.getState().audio.input).toEqual({ id: "yeti", name: "Yeti Stereo Microphone" });
  expect(screen.getByRole("button", { name: "Microphone: Yeti Stereo Microphone" })).toBeTruthy();
});

it("shows how loud the microphone is and which one is heard", async () => {
  await show();
  expect(screen.getByText("Hearing LG UltraFine Display Audio")).toBeTruthy();
  expect(Number(screen.getByRole("meter", { name: "Microphone level" }).getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  expect(invoke).toHaveBeenCalledWith("voice_audio_meter", { on: true });
  cleanup();
  expect(invoke).toHaveBeenCalledWith("voice_audio_meter", { on: false });
});

it("says what isn't as chosen", async () => {
  NOW.notes = ["Echo cancelling won’t work with Yeti Stereo Microphone, so Desk quiets the microphone while it speaks."];
  await show();
  expect(screen.getByRole("status").textContent).toContain("Echo cancelling won’t work with Yeti");
  NOW.notes = [];
});

it("turns echo cancelling off, worded for the platform", async () => {
  await show();
  expect(screen.getByText(/Removes Desk’s own voice/)).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "Echo cancelling" }));
  expect(useSettings.getState().audio.echoCancel).toBe(false);
  cleanup();
  useHost.setState({ ...DEFAULT_HOST, platform: "windows" });
  await show();
  expect(screen.getByText(/Quiets the microphone while Desk speaks/)).toBeTruthy();
});

it("saves sensitivity once the slider is let go, not at every step", async () => {
  await show();
  const slider = screen.getByLabelText(/Input sensitivity/);
  fireEvent.change(slider, { target: { value: "0.8" } });
  expect(useSettings.getState().audio.sensitivity).toBe(0.5);
  fireEvent.pointerUp(slider);
  expect(useSettings.getState().audio.sensitivity).toBe(0.8);
});

it("asks for the keys when push to talk only is on", async () => {
  await show();
  expect(screen.queryByRole("button", { name: /shortcut$/ })).toBeNull();
  fireEvent.click(screen.getByRole("switch", { name: "Push to talk only" }));
  expect(useSettings.getState().audio.pushToTalkOnly).toBe(true);
  expect(screen.getByRole("button", { name: /shortcut$/ })).toBeTruthy();
});

it("records, then plays back, then says it's done", async () => {
  await show();
  fireEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(screen.getByText("Recording — say something…")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3100);
  });
  expect(screen.getByText("Playing it back…")).toBeTruthy();
  await act(async () => tested());
  expect(screen.getByText(/^Done\./)).toBeTruthy();
});

it("keeps a remembered device that's away, shown as not connected", () => {
  const entries = deviceEntries(DEVICES.inputs, { id: "airpods", name: "AirPods Pro" }, () => {});
  const away = entries.at(-1);
  expect(away).toMatchObject({ label: "AirPods Pro", hint: "not connected", checked: true, disabled: true });
  // Found again by name when its id changed.
  const back = deviceEntries(DEVICES.inputs, { id: "yeti-2", name: "Yeti Stereo Microphone" }, () => {});
  expect(back.find((e) => e.kind === "item" && e.label === "Yeti Stereo Microphone")).toMatchObject({ checked: true });
});

it("meters from silence to full scale in decibels", () => {
  expect(meterFill(0)).toBe(0);
  expect(meterFill(0.001)).toBeCloseTo(0);
  expect(meterFill(0.0316)).toBeCloseTo(0.5, 1);
  expect(meterFill(1)).toBe(1);
});
