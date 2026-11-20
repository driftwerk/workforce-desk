import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../settings/store";
import { DmVoiceBar, DmVoiceControls, MicBadge } from "./DmVoice";
import { useChat } from "../chat/store";
import { defaultShortcuts } from "../shortcuts/keys";
import { QUIET, toggleTalk, useMic } from "./mic";
import { useVoiceStore } from "./store";
import { useVoice } from "./useVoice";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(), unregister: vi.fn() }));

const key = "local/atlas";
const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === command).map(([, args]) => args);

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(() => Promise.resolve());
  useMic.setState(QUIET);
  useSettings.setState({ writtenReplies: [], loaded: true, keys: defaultShortcuts("macos") });
  useVoiceStore.setState({ here: true, status: { state: "listening", conversation: null }, waiting: {}, speakingFor: null });
});
afterEach(cleanup);

describe("a DM's voice controls", () => {
  it("talk until ended", () => {
    render(<DmVoiceControls agent={key} name="Atlas" />);
    fireEvent.click(screen.getByLabelText("Talk with Atlas"));
    expect(useMic.getState().talk).toBe(key);
    fireEvent.click(screen.getByLabelText("End the conversation with Atlas"));
    expect(useMic.getState().talk).toBeNull();
  });

  it("hold to talk while the button's down", () => {
    render(<DmVoiceControls agent={key} name="Atlas" />);
    const button = screen.getByLabelText("Hold to talk to Atlas");
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    expect(useMic.getState()).toMatchObject({ hold: key, pressed: true });
    expect(calls("voice_push_to_talk")).toEqual([{ pressed: true }]);
    fireEvent.pointerUp(button, { pointerId: 1 });
    expect(useMic.getState()).toMatchObject({ hold: key, pressed: false });
    expect(calls("voice_push_to_talk")).toEqual([{ pressed: true }, { pressed: false }]);
  });

  it("let a hold go if they go while it's held", () => {
    const { unmount } = render(<DmVoiceControls agent={key} name="Atlas" />);
    fireEvent.pointerDown(screen.getByLabelText("Hold to talk to Atlas"), { button: 0, pointerId: 1 });
    unmount();
    expect(useMic.getState()).toMatchObject({ hold: key, pressed: false });
    expect(calls("voice_push_to_talk")).toEqual([{ pressed: true }, { pressed: false }]);
  });

  it("choose whether the agent answers aloud or in writing, kept per agent", () => {
    render(<DmVoiceControls agent={key} name="Atlas" />);
    fireEvent.click(screen.getByLabelText("How Atlas answers when you talk"));
    fireEvent.click(screen.getByText("Atlas answers in writing"));
    expect(useSettings.getState().writtenReplies).toEqual([key]);
    fireEvent.click(screen.getByLabelText("How Atlas answers when you talk"));
    fireEvent.click(screen.getByText("Atlas answers aloud"));
    expect(useSettings.getState().writtenReplies).toEqual([]);
  });

  it("aren't shown in a window voice doesn't run in", () => {
    useVoiceStore.setState({ here: false });
    render(<DmVoiceControls agent={key} name="Atlas" />);
    expect(screen.queryByLabelText("Talk with Atlas")).toBeNull();
  });
});

describe("a DM's voice bar and badge", () => {
  it("say the DM has the microphone, with a way to end it", () => {
    act(() => toggleTalk(key));
    render(
      <>
        <MicBadge agent={key} />
        <MicBadge agent="local/scout" />
        <DmVoiceBar agent={key} name="Atlas" />
      </>,
    );
    expect(screen.getAllByLabelText("Has the microphone")).toHaveLength(1);
    expect(screen.getByText("Atlas is listening")).toBeTruthy();
    expect(screen.getByText("Atlas answers aloud")).toBeTruthy();
    fireEvent.click(screen.getByText("End"));
    expect(useMic.getState().talk).toBeNull();
    expect(screen.queryByText("Atlas is listening")).toBeNull();
  });

  it("mute the conversation and unmute it, without ending it", () => {
    act(() => toggleTalk(key));
    render(<DmVoiceBar agent={key} name="Atlas" />);
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(useMic.getState()).toMatchObject({ talk: key, muted: true });
    expect(screen.getByText("You’re muted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(useMic.getState().muted).toBe(false);
  });
});

describe("voice's shortcuts, wherever you are", () => {
  const press = (code: string) => act(() => void fireEvent.keyDown(window, { code, ctrlKey: true, shiftKey: true }));

  it("end the conversation with Talk here when no DM is shown, and mute it", () => {
    const { unmount } = renderHook(() => useVoice(false));
    act(() => toggleTalk(key));
    press("KeyO");
    expect(useMic.getState().muted).toBe(true);
    press("KeyO");
    expect(useMic.getState().muted).toBe(false);
    press("KeyL");
    expect(useMic.getState().talk).toBeNull();
    press("KeyO");
    expect(useMic.getState().muted).toBe(false);
    unmount();
  });
});

describe("a conversation's agent leaving the roster", () => {
  const atlas = { hubId: "local", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false };

  it("ends it, once the roster has been read without it", () => {
    useChat.setState({ roster: [atlas], rosterRead: false });
    const { unmount } = renderHook(() => useVoice(false));
    act(() => toggleTalk(key));
    act(() => useChat.setState({ roster: [] }));
    expect(useMic.getState().talk).toBe(key);
    act(() => useChat.setState({ roster: [atlas], rosterRead: true }));
    expect(useMic.getState().talk).toBe(key);
    act(() => useChat.setState({ roster: [] }));
    expect(useMic.getState().talk).toBeNull();
    unmount();
  });
});

describe("voice following the microphone", () => {
  it("claims it for a DM and gives it back, voice by name off or on", async () => {
    const { unmount } = renderHook(() => useVoice(false));
    await act(async () => toggleTalk(key));
    expect(calls("voice_claim")).toEqual([{ mode: "open" }]);
    await act(async () => useMic.setState({ hold: "local/scout", pressed: true }));
    expect(calls("voice_claim").at(-1)).toEqual({ mode: "held" });
    await act(async () => useMic.setState({ hold: null, pressed: false, talk: null }));
    expect(calls("voice_claim").at(-1)).toEqual({ mode: null });
    unmount();
  });

  it("goes back to voice by name, saying why in the DM, when it can't be had", async () => {
    vi.mocked(invoke).mockImplementation((cmd) => (cmd === "voice_claim" ? Promise.reject(new Error("microphone access was denied")) : Promise.resolve()));
    const { unmount } = renderHook(() => useVoice(false));
    await act(async () => toggleTalk(key));
    await act(async () => undefined);
    expect(useMic.getState()).toMatchObject({ talk: null, problem: { agent: key, message: "microphone access was denied" } });
    unmount();
  });
});
