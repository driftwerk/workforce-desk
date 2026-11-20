import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Agent, ChatMessage } from "../chat/types";
import { emptyConversation } from "../chat/conversation";
import { openTarget } from "../shell/navigate";
import { useUi } from "../shell/ui";
import { useSettings } from "../settings/store";
import { defaultShortcuts } from "../shortcuts/keys";
import { resetShown, useDmPresence } from "./dms";
import { micFailed, QUIET, toggleTalk, useMic } from "./mic";
import { useVoiceStore } from "./store";
import { TalkPill } from "./TalkPill";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("../shell/navigate", () => ({ openTarget: vi.fn() }));

const agent = (id: string, name: string, hubId = "local"): Agent => ({ hubId, id, name, model: null, provider: null, isDefault: false });
const key = "local/kat";
const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === command).map(([, args]) => args);

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  vi.mocked(openTarget).mockClear();
  resetShown();
  useMic.setState(QUIET);
  useSettings.setState({ writtenReplies: [], loaded: true, keys: defaultShortcuts("macos") });
  useVoiceStore.setState({ here: true, status: { state: "listening", conversation: null }, waiting: {}, speakingFor: null });
  useChat.setState({
    hubs: [
      { id: "local", label: "This computer", url: "", local: true, revision: "" },
      { id: "office", label: "Office", url: "", local: false, revision: "" },
    ],
    roster: [agent("kat", "Kat"), agent("ash", "Ash"), agent("ash", "Ash", "office")],
    conversations: {},
  });
});
afterEach(cleanup);

const pill = () => screen.getByRole("group", { name: "Talking with Kat" });
const status = () => screen.getByRole("button", { name: /Listening|Thinking|Speaking|Muted|Microphone|Paused|Transcribing/ });

function Dm({ agent }: { agent: string }) {
  const root = useRef<HTMLElement | null>(null);
  useDmPresence(agent, root);
  return (
    <main
      ref={(el) => {
        root.current = el;
      }}
    />
  );
}

describe("the title bar's pill", () => {
  it("shows nothing without a spoken conversation, or where voice doesn't run", () => {
    const { container } = render(<TalkPill />);
    expect(container.innerHTML).toBe("");
    act(() => {
      toggleTalk(key);
      useVoiceStore.setState({ here: false });
    });
    expect(container.innerHTML).toBe("");
  });

  it("says who you're talking with and what's happening, from every view", () => {
    act(() => toggleTalk(key));
    render(<TalkPill />);
    expect(within(pill()).getByText("Kat")).toBeTruthy();
    expect(status().textContent).toMatch(/^Listening · 0:0\d$/);
    expect(screen.getByRole("status").textContent).toBe("Kat: Listening");
    act(() => useVoiceStore.setState({ waiting: { [key]: true } }));
    expect(status().textContent).toBe("Thinking…");
    act(() => useVoiceStore.setState({ waiting: {}, status: { state: "speaking" }, speakingFor: key }));
    fireEvent.click(screen.getByRole("button", { name: "Stop reply" }));
    expect(calls("voice_stop_speaking")).toHaveLength(1);
  });

  it("opens the agent's DM from its name, leaving Settings", () => {
    act(() => {
      toggleTalk(key);
      useUi.getState().openSettings("profile");
    });
    render(<TalkPill />);
    fireEvent.click(screen.getByRole("button", { name: "Open Kat’s DM" }));
    expect(useUi.getState().settings).toBeNull();
    expect(openTarget).toHaveBeenCalledWith({ kind: "agent", key });
  });

  it("mutes without ending, and a tap on what it says unmutes", () => {
    act(() => toggleTalk(key));
    render(<TalkPill />);
    fireEvent.click(screen.getByRole("button", { name: "Mute your microphone" }));
    expect(useMic.getState()).toMatchObject({ talk: key, muted: true });
    expect(screen.getByRole("button", { name: "Unmute your microphone" })).toBeTruthy();
    expect(pill().className).toContain("talk-muted");
    fireEvent.click(screen.getByRole("button", { name: "Muted — tap to talk" }));
    expect(useMic.getState().muted).toBe(false);
  });

  it("ends the conversation", () => {
    act(() => toggleTalk(key));
    const { container } = render(<TalkPill />);
    fireEvent.click(within(pill()).getByRole("button", { name: "End" }));
    expect(useMic.getState().talk).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("is only a dot in the agent's own DM, which still opens the controls", () => {
    act(() => toggleTalk(key));
    const { rerender } = render(
      <>
        <TalkPill />
        <Dm agent={key} />
      </>,
    );
    expect(screen.queryByRole("group", { name: "Talking with Kat" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Talking with Kat: conversation controls" }));
    expect(screen.getByRole("dialog", { name: "Talking with Kat" })).toBeTruthy();
    rerender(
      <>
        <TalkPill />
        <Dm agent="local/ash" />
      </>,
    );
    expect(pill()).toBeTruthy();
  });

  it("offers how the agent answers, the microphone and speaker, from ▾", () => {
    act(() => toggleTalk(key));
    render(<TalkPill />);
    fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitemradio", { name: "Kat answers aloud" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByText("Kat answers in writing"));
    expect(useSettings.getState().writtenReplies).toEqual([key]);
  });
});

describe("the pill's popover", () => {
  const open = () => {
    fireEvent.click(status());
    return screen.getByRole("dialog", { name: "Talking with Kat" });
  };
  const msg = (id: string, role: ChatMessage["role"], content: string): ChatMessage => ({ id, role, content, at: new Date().toISOString(), status: "complete", tools: [] });

  it("opens over the page, and closes on Escape, giving focus back, or a click elsewhere", () => {
    act(() => toggleTalk(key));
    render(<TalkPill />);
    const from = status();
    const pop = open();
    expect(from.getAttribute("aria-expanded")).toBe("true");
    expect(within(pop).getByText("Talking with Kat")).toBeTruthy();
    expect(within(pop).getByText(/^Started in the DM · 0:0\d$/)).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(from);
    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays open while a menu from it is used, which Escape closes first", () => {
    act(() => toggleTalk(key));
    render(<TalkPill />);
    const pop = open();
    fireEvent.click(within(pop).getByRole("button", { name: /^Microphone/ }));
    const menu = screen.getByRole("menu", { name: "Microphone" });
    fireEvent.mouseDown(within(menu).getByText("Same as system"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(within(menu).getByText("Same as system"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("shows the last exchange of this conversation", () => {
    act(() => toggleTalk(key));
    render(<TalkPill />);
    const pop = open();
    expect(within(pop).getByText("Nothing said yet: talk, and Kat hears it.")).toBeTruthy();
    act(() =>
      useChat.setState({
        conversations: {
          [key]: { ...emptyConversation(), messages: [msg("1", "user", "check my inbox"), msg("2", "assistant", "Two new since nine.")] },
        },
      }),
    );
    expect(within(pop).getByText("check my inbox")).toBeTruthy();
    expect(within(pop).getByText("Two new since nine.")).toBeTruthy();
  });

  it("mutes, holds to talk and ends", () => {
    act(() => toggleTalk(key));
    render(<TalkPill />);
    const pop = open();
    fireEvent.click(within(pop).getByRole("button", { name: "Mute" }));
    expect(useMic.getState().muted).toBe(true);
    fireEvent.click(within(pop).getByRole("button", { name: "Unmute" }));
    const hold = within(pop).getByRole("button", { name: "Hold to talk" });
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    expect(useMic.getState()).toMatchObject({ hold: key, pressed: true });
    fireEvent.pointerUp(hold, { pointerId: 1 });
    expect(calls("voice_push_to_talk")).toEqual([{ pressed: true }, { pressed: false }]);
    fireEvent.click(within(pop).getByRole("button", { name: "End" }));
    expect(useMic.getState().talk).toBeNull();
  });

  it("moves the conversation to another agent, naming its workspace where names repeat", () => {
    act(() => toggleTalk(key));
    render(<TalkPill />);
    fireEvent.click(within(open()).getByRole("button", { name: /^Switch to/ }));
    const menu = screen.getByRole("menu", { name: "Switch to" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Ash · This computer", "Ash · Office"]);
    fireEvent.click(within(menu).getByText("· Office").closest("button")!);
    expect(useMic.getState()).toMatchObject({ talk: "office/ash", from: key });
    expect(screen.getByRole("group", { name: "Talking with Ash" })).toBeTruthy();
  });

  it("says what kept the microphone, with a way to try again or dismiss it", () => {
    act(() => {
      toggleTalk(key);
      micFailed({ agent: key, mode: "talk" }, "Desk isn't allowed to use the microphone");
    });
    render(<TalkPill />);
    expect(pill().className).toContain("talk-problem");
    expect(screen.queryByRole("button", { name: "Mute your microphone" })).toBeNull();
    const pop = open();
    expect(within(pop).getByText("Allow Desk to use the microphone.")).toBeTruthy();
    expect(within(pop).getByRole("button", { name: "Open Microphone settings" })).toBeTruthy();
    fireEvent.click(within(pop).getByRole("button", { name: "Try again" }));
    expect(useMic.getState()).toMatchObject({ talk: key, problem: null });
    act(() => micFailed({ agent: key, mode: "talk" }, "no input device"));
    expect(status().textContent).toBe("Microphone problem — fix");
    fireEvent.click(within(pill()).getByRole("button", { name: "Dismiss" }));
    expect(useMic.getState().problem).toBeNull();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("leaves a hold that failed to its DM, never offering to start a conversation", () => {
    const { container } = render(<TalkPill />);
    act(() => micFailed({ agent: key, mode: "hold" }, "Desk isn't allowed to use the microphone"));
    expect(container.innerHTML).toBe("");
  });

  it("keeps focus where it is as the conversation changes, so a held key holds", () => {
    act(() => toggleTalk(key));
    render(<TalkPill />);
    const pop = open();
    const hold = within(pop).getByRole("button", { name: "Hold to talk" });
    act(() => hold.focus());
    fireEvent.keyDown(hold, { key: " " });
    expect(useMic.getState()).toMatchObject({ hold: key, pressed: true });
    act(() => useVoiceStore.setState({ status: { state: "transcribing" }, waiting: { [key]: true } }));
    expect(document.activeElement).toBe(hold);
    expect(useMic.getState().pressed).toBe(true);
    fireEvent.keyUp(hold, { key: " " });
    expect(useMic.getState().pressed).toBe(false);
  });

  it("shows the agent's key while its name isn't known, so a live microphone is never hidden", () => {
    act(() => {
      toggleTalk(key);
      useChat.setState({ roster: [] });
    });
    render(<TalkPill />);
    expect(screen.getByRole("group", { name: `Talking with ${key}` })).toBeTruthy();
  });

  it("closes when the conversation ends elsewhere, and doesn't open again with the next", () => {
    act(() => toggleTalk(key));
    render(<TalkPill />);
    open();
    act(() => toggleTalk(key));
    act(() => toggleTalk(key));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pill()).toBeTruthy();
  });
});
