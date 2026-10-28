import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShortcuts } from "../shortcuts/manager";
import { Calls } from "./Calls";
import { useSettings } from "./store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

beforeEach(() => {
  useSettings.setState({ pushToTalkShortcut: "Control+Shift+Space", askShortcut: "Alt+Space", loaded: false });
  useShortcuts.setState({ status: { pushToTalk: { state: "off" }, ask: { state: "off" } }, recording: false });
});

afterEach(cleanup);

const recorder = (name: string) => screen.getByRole("button", { name: `${name} shortcut` });
const keys = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);

describe("shortcut recorder", () => {
  it("records a combo and shows it everywhere Calls mentions it", () => {
    render(<Calls />);
    expect(screen.getByText(/or hold ⌃⇧Space to talk/)).toBeTruthy();
    fireEvent.click(recorder("Hold to talk"));
    expect(recorder("Hold to talk").textContent).toBe("Press the keys…");
    expect(useShortcuts.getState().recording).toBe(true);
    keys({ code: "ControlLeft", ctrlKey: true });
    keys({ code: "AltLeft", ctrlKey: true, altKey: true });
    expect(recorder("Hold to talk").textContent).toBe("⌃⌥…");
    keys({ code: "KeyK", key: "˚", ctrlKey: true, altKey: true });
    expect(useSettings.getState().pushToTalkShortcut).toBe("Control+Alt+K");
    expect(recorder("Hold to talk").textContent).toBe("⌃⌥K");
    expect(screen.getByText(/or hold ⌃⌥K to talk/)).toBeTruthy();
    expect(useShortcuts.getState().recording).toBe(false);
  });

  it("Esc cancels and keeps the shortcut", () => {
    render(<Calls />);
    fireEvent.click(recorder("Ask anyone"));
    keys({ code: "Escape", key: "Escape" });
    expect(useSettings.getState().askShortcut).toBe("Alt+Space");
    expect(recorder("Ask anyone").textContent).toBe("⌥Space");
  });

  it("refuses what macOS keeps, says why, and keeps listening", () => {
    render(<Calls />);
    fireEvent.click(recorder("Hold to talk"));
    keys({ code: "Space", altKey: true, metaKey: true });
    expect(screen.getByRole("alert").textContent).toBe("macOS uses ⌥⌘Space for the Finder search window — choose another");
    expect(useSettings.getState().pushToTalkShortcut).toBe("Control+Shift+Space");
    keys({ code: "KeyJ", ctrlKey: true, altKey: true });
    expect(useSettings.getState().pushToTalkShortcut).toBe("Control+Alt+J");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses the other shortcut's keys", () => {
    render(<Calls />);
    fireEvent.click(recorder("Hold to talk"));
    keys({ code: "Space", altKey: true });
    expect(screen.getByRole("alert").textContent).toBe("⌥Space is already Ask anyone — choose another");
    expect(useSettings.getState().pushToTalkShortcut).toBe("Control+Shift+Space");
  });

  it("says where it's configured when another app has the keys, and offers the default back", () => {
    useSettings.setState({ askShortcut: "Control+Alt+A" });
    render(<Calls />);
    act(() =>
      useShortcuts.setState({
        status: { pushToTalk: { state: "taken", message: "⌃⇧Space is taken by another app — choose another" }, ask: { state: "ready" } },
      }),
    );
    expect(screen.getByRole("alert").textContent).toBe("⌃⇧Space is taken by another app — choose another");
    fireEvent.click(screen.getByRole("button", { name: "Use ⌥Space" }));
    expect(useSettings.getState().askShortcut).toBe("Alt+Space");
  });
});
