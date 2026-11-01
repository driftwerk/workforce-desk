import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { defaultShortcuts } from "../shortcuts/keys";
import { useShortcuts } from "../shortcuts/manager";
import { Calls } from "./Calls";
import { Shortcuts } from "./Shortcuts";
import { useSettings } from "./store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

beforeEach(() => {
  useSettings.setState({ shortcuts: {}, keys: defaultShortcuts(), loaded: false });
  useShortcuts.setState({ status: { pushToTalk: { state: "off" }, ask: { state: "off" } }, recording: false });
});

afterEach(cleanup);

const recorder = (name: string) => screen.getByRole("button", { name: `${name} shortcut` });
const keys = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);
const keysOf = () => useSettings.getState().keys;

describe("Keyboard shortcuts", () => {
  it("lists every shortcut with its keys, from any app and in Desk", () => {
    render(<Shortcuts />);
    expect(screen.getByRole("heading", { name: "Keyboard shortcuts" })).toBeTruthy();
    expect(recorder("Ask anyone").textContent).toBe("⌃⇧K");
    expect(recorder("Hold to talk").textContent).toBe("⌃⇧Space");
    expect(recorder("New session").textContent).toBe("⌘N");
    expect(recorder("Settings").textContent).toBe("⌘,");
    expect(recorder("Save a file").textContent).toBe("⌘S");
    expect(screen.queryByRole("button", { name: /^Reset to/ })).toBeNull();
  });

  it("says the keys a shortcut takes in a terminal, where the shell keeps Ctrl and a letter", () => {
    render(<Shortcuts />);
    expect(screen.queryByText(/In a terminal/)).toBeNull();
    cleanup();
    useHost.setState({ ...DEFAULT_HOST, platform: "linux" });
    useSettings.setState({ keys: defaultShortcuts("linux") });
    render(<Shortcuts />);
    expect(recorder("New session").textContent).toBe("Ctrl+N");
    expect(screen.getAllByText(/In a terminal/).map((e) => e.textContent)).toEqual([
      "In a terminal: Ctrl+Shift+N (the shell keeps Ctrl+N)",
      "In a terminal: Ctrl+Shift+T (the shell keeps Ctrl+T)",
      "In a terminal: Ctrl+Shift+R (the shell keeps Ctrl+R)",
      "In a terminal: Ctrl+Shift+S (the shell keeps Ctrl+S)",
    ]);
    useHost.setState(DEFAULT_HOST);
  });

  it("records a combo and shows it where Calls mentions it", () => {
    render(<Shortcuts />);
    fireEvent.click(recorder("Hold to talk"));
    expect(recorder("Hold to talk").textContent).toBe("Press the keys…");
    expect(useShortcuts.getState().recording).toBe(true);
    keys({ code: "ControlLeft", ctrlKey: true });
    keys({ code: "AltLeft", ctrlKey: true, altKey: true });
    expect(recorder("Hold to talk").textContent).toBe("⌃⌥…");
    keys({ code: "KeyK", key: "˚", ctrlKey: true, altKey: true });
    expect(keysOf().pushToTalk).toBe("Control+Alt+K");
    expect(useSettings.getState().shortcuts).toEqual({ pushToTalk: "Control+Alt+K" });
    expect(recorder("Hold to talk").textContent).toBe("⌃⌥K");
    expect(useShortcuts.getState().recording).toBe(false);
    cleanup();
    render(<Calls />);
    expect(screen.getByText(/or hold ⌃⌥K to talk/)).toBeTruthy();
  });

  it("lets an in-Desk shortcut be ⌘ and a key, but not one Desk's menu has", () => {
    render(<Shortcuts />);
    fireEvent.click(recorder("New session"));
    keys({ code: "KeyC", metaKey: true });
    expect(screen.getByRole("alert").textContent).toBe("⌘C is Copy — choose another");
    keys({ code: "KeyY", metaKey: true });
    expect(keysOf().newSession).toBe("Primary+Y");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Esc cancels and keeps the shortcut", () => {
    render(<Shortcuts />);
    fireEvent.click(recorder("Ask anyone"));
    keys({ code: "Escape", key: "Escape" });
    expect(keysOf().ask).toBe("Control+Shift+K");
    expect(recorder("Ask anyone").textContent).toBe("⌃⇧K");
  });

  it("refuses what macOS keeps, says why, and keeps listening", () => {
    render(<Shortcuts />);
    fireEvent.click(recorder("Hold to talk"));
    keys({ code: "Space", altKey: true, metaKey: true });
    expect(screen.getByRole("alert").textContent).toBe("macOS uses ⌥⌘Space for the Finder search window — choose another");
    expect(keysOf().pushToTalk).toBe("Control+Shift+Space");
    keys({ code: "KeyY", ctrlKey: true, altKey: true });
    expect(keysOf().pushToTalk).toBe("Control+Alt+Y");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses another of Desk's shortcuts' keys, global or in Desk", () => {
    render(<Shortcuts />);
    fireEvent.click(recorder("Hold to talk"));
    keys({ code: "KeyK", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("alert").textContent).toBe("⌃⇧K is already Ask anyone — choose another");
    expect(keysOf().pushToTalk).toBe("Control+Shift+Space");
    keys({ code: "Escape" });
    fireEvent.click(recorder("Save a file"));
    keys({ code: "KeyN", metaKey: true });
    expect(screen.getByRole("alert").textContent).toBe("⌘N is already New session — choose another");
    expect(keysOf().saveFile).toBe("Primary+S");
  });

  it("lets you choose ⌥Space, saying launchers often take it", () => {
    render(<Shortcuts />);
    fireEvent.click(recorder("Ask anyone"));
    keys({ code: "Space", altKey: true });
    expect(keysOf().ask).toBe("Alt+Space");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Launchers like Raycast, Alfred, ChatGPT and Claude often use ⌥Space — if nothing happens, choose another")).toBeTruthy();
  });

  it("resets to the default, unless another shortcut has it now", () => {
    useSettings.getState().set({ shortcuts: { ask: "Control+Alt+A", pushToTalk: "Control+Alt+Y" } });
    render(<Shortcuts />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to ⌃⇧Space" }));
    expect(keysOf().pushToTalk).toBe("Control+Shift+Space");
    expect(useSettings.getState().shortcuts).toEqual({ ask: "Control+Alt+A" });
    act(() => useSettings.getState().setShortcut("newSession", "Control+Shift+K"));
    fireEvent.click(screen.getByRole("button", { name: "Reset to ⌃⇧K" }));
    expect(screen.getByRole("alert").textContent).toBe("⌃⇧K is already New session — choose another");
    expect(keysOf().ask).toBe("Control+Alt+A");
  });

  it("says when another app has a global shortcut's keys", () => {
    render(<Shortcuts />);
    act(() =>
      useShortcuts.setState({
        status: { pushToTalk: { state: "taken", message: "Hold to talk can’t use ⌃⇧Space: another app already has it — choose other keys" }, ask: { state: "ready" } },
      }),
    );
    expect(screen.getByRole("alert").textContent).toBe("Hold to talk can’t use ⌃⇧Space: another app already has it — choose other keys");
  });
});
