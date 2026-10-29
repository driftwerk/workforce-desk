import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../settings/store";
import { DEFAULT_SHORTCUTS } from "./keys";
import { settled, useAppShortcut, useGlobalShortcut, useShortcuts } from "./manager";

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
      message: "⌃⇧Space is taken by another app — choose another",
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
    useSettings.setState({ shortcuts: {}, keys: DEFAULT_SHORTCUTS });
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
});
