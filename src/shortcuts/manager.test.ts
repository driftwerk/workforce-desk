import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../settings/store";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { defaultShortcuts } from "./keys";
import { allowedFrom, settled, useAppShortcut, useGlobalShortcut, useShortcuts } from "./manager";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: vi.fn(() => Promise.resolve()),
  unregister: vi.fn(() => Promise.resolve()),
}));

const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.mocked(register).mockImplementation(async (s) => void calls.push(`register ${String(s)}`));
  vi.mocked(unregister).mockImplementation(async (s) => void calls.push(`unregister ${String(s)}`));
  useShortcuts.setState({ status: { pushToTalk: { state: "off" }, ask: { state: "off" } }, recording: false });
});

afterEach(cleanup);

const flush = () => act(() => settled());

describe("global shortcuts", () => {
  it("lets go of the old keys before taking the new ones", async () => {
    const { rerender, unmount } = renderHook(({ accel }) => useGlobalShortcut("ask", accel, () => {}), {
      initialProps: { accel: "Alt+Space" as string | null },
    });
    await flush();
    expect(useShortcuts.getState().status.ask).toEqual({ state: "ready" });
    rerender({ accel: "Control+Alt+K" });
    await flush();
    unmount();
    await flush();
    expect(calls).toEqual(["register Alt+Space", "unregister Alt+Space", "register Control+Alt+K", "unregister Control+Alt+K"]);
    expect(useShortcuts.getState().status.ask).toEqual({ state: "off" });
  });

  it("says in plain words when another app has the keys, and doesn't release what it never held", async () => {
    vi.mocked(register).mockRejectedValueOnce(new Error("RegisterEventHotKey failed for Space"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { unmount } = renderHook(() => useGlobalShortcut("pushToTalk", "Control+Shift+Space", () => {}));
    await flush();
    expect(useShortcuts.getState().status.pushToTalk).toEqual({
      state: "taken",
      message: "Hold to talk can’t use ⌃⇧Space: another app already has it — choose other keys",
    });
    unmount();
    await flush();
    expect(unregister).not.toHaveBeenCalledWith("Control+Shift+Space");
    warn.mockRestore();
  });

  it("steps aside while a shortcut is being recorded", async () => {
    renderHook(() => useGlobalShortcut("ask", "Alt+Space", () => {}));
    await flush();
    act(() => useShortcuts.setState({ recording: true }));
    await flush();
    act(() => useShortcuts.setState({ recording: false }));
    await flush();
    expect(calls).toEqual(["register Alt+Space", "unregister Alt+Space", "register Alt+Space"]);
  });

  it("holds nothing while off", async () => {
    renderHook(() => useGlobalShortcut("pushToTalk", null, () => {}));
    await flush();
    expect(register).not.toHaveBeenCalled();
  });
});

describe("shortcuts in Desk", () => {
  const press = (init: KeyboardEventInit) => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", init)));

  it("run on the configured keys only, and not while one is being recorded", () => {
    useSettings.setState({ shortcuts: {}, keys: defaultShortcuts() });
    const onPress = vi.fn();
    renderHook(() => useAppShortcut("newSession", onPress));
    press({ code: "KeyN", key: "n", metaKey: true });
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => useSettings.getState().setShortcut("newSession", "Super+J"));
    press({ code: "KeyN", key: "n", metaKey: true });
    press({ code: "KeyJ", key: "j", metaKey: true, shiftKey: true });
    expect(onPress).toHaveBeenCalledTimes(1);
    press({ code: "KeyJ", key: "j", metaKey: true });
    expect(onPress).toHaveBeenCalledTimes(2);
    act(() => useShortcuts.setState({ recording: true }));
    press({ code: "KeyJ", key: "j", metaKey: true });
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it.each(["windows", "linux"] as const)("on %s, leave Ctrl and a letter to a terminal pane and run on Ctrl+Shift there", (platform) => {
    useHost.setState({ ...DEFAULT_HOST, platform });
    useSettings.setState({ shortcuts: {}, keys: defaultShortcuts(platform) });
    const pane = document.body.appendChild(document.createElement("div"));
    pane.setAttribute("data-terminal", "");
    const field = pane.appendChild(document.createElement("textarea"));
    const pressIn = (el: Element, init: KeyboardEventInit) =>
      act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })));
    const session = vi.fn();
    const settings = vi.fn();
    renderHook(() => useAppShortcut("newSession", session));
    renderHook(() => useAppShortcut("settings", settings));
    pressIn(field, { code: "KeyN", key: "n", ctrlKey: true });
    expect(session).not.toHaveBeenCalled();
    pressIn(field, { code: "KeyN", key: "N", ctrlKey: true, shiftKey: true });
    expect(session).toHaveBeenCalledTimes(1);
    pressIn(field, { code: "Comma", key: ",", ctrlKey: true });
    expect(settings).toHaveBeenCalledTimes(1);
    pressIn(document.body, { code: "KeyN", key: "n", ctrlKey: true });
    expect(session).toHaveBeenCalledTimes(2);
    pane.remove();
    useHost.setState(DEFAULT_HOST);
  });
});

describe("room shortcuts' guard", () => {
  const el = (html: string, pick: string): Element => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.querySelector(pick)!;
  };

  it("never acts on keys typed in a terminal or a settings field, and does in a room composer", () => {
    expect(allowedFrom(el(`<div class="xterm"><textarea></textarea></div>`, "textarea"))).toBe(false);
    expect(allowedFrom(el(`<div class="terminal-frame"><span></span></div>`, "span"))).toBe(false);
    expect(allowedFrom(el(`<label>Name <input></label>`, "input"))).toBe(false);
    expect(allowedFrom(el(`<div contenteditable="true"></div>`, "div"))).toBe(false);
    expect(allowedFrom(el(`<form data-composer><textarea></textarea></form>`, "textarea"))).toBe(true);
    expect(allowedFrom(el(`<main><button>Thread</button></main>`, "button"))).toBe(true);
    expect(allowedFrom(document.body)).toBe(true);
  });

  it("leaves a key pressed in a field alone, with the guard", () => {
    const pressed = vi.fn();
    const { unmount } = renderHook(() => useAppShortcut("stopAnswer", pressed, true, { fromFields: false }));
    const input = document.body.appendChild(document.createElement("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "Period", metaKey: true, bubbles: true }));
    expect(pressed).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Period", metaKey: true }));
    expect(pressed).toHaveBeenCalledTimes(1);
    input.remove();
    unmount();
  });
});
