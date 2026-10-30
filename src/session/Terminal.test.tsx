import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import { useSettings } from "../settings/store";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { defaultShortcuts } from "../shortcuts/keys";
import { useAppShortcut } from "../shortcuts/manager";
import { NIGHT } from "../theme/builtin";
import { useThemeStore } from "../theme/store";
import { Terminal } from "./Terminal";

const terms: { options: Record<string, unknown>; field?: HTMLTextAreaElement }[] = [];
vi.mock("@xterm/xterm", () => ({
  // Like xterm: its text field takes the keys, and a key the custom handler
  // doesn't keep back is typed (Ctrl and a letter as its control character).
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    field?: HTMLTextAreaElement;
    private keys?: (e: KeyboardEvent) => boolean;
    private data?: (d: string) => void;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      terms.push(this);
    }
    loadAddon() {}
    open(el: HTMLElement) {
      this.field = el.appendChild(document.createElement("textarea"));
      this.field.addEventListener("keydown", (e) => {
        if (this.keys?.(e) === false) return;
        if (e.ctrlKey && /^Key[A-Z]$/.test(e.code)) this.data?.(String.fromCharCode(e.code.charCodeAt(3) - 64));
      });
    }
    write() {}
    focus() {}
    resize() {}
    dispose() {}
    onData(f: (d: string) => void) {
      this.data = f;
      return { dispose() {} };
    }
    attachCustomKeyEventHandler(f: (e: KeyboardEvent) => boolean) {
      this.keys = f;
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(), unregister: vi.fn() }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { proposeDimensions = () => ({ cols: 80, rows: 24 }); } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

afterEach(cleanup);

describe("a terminal", () => {
  it("is drawn in the theme's code face and size, and follows them when they change", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const socket = { readyState: 0, send: vi.fn(), close: vi.fn() };
    useDesk.setState({ hub: { ptySocket: () => socket } as never });
    const mine = { ...NIGHT, id: "mine", name: "Mine", fonts: { ...NIGHT.fonts, mono: "Menlo", codeSize: 15 } };
    useThemeStore.setState({ choice: "mine", custom: [mine] });
    render(<Terminal sessionId="s1" />);
    const term = terms.at(-1)!;
    expect(term.options.fontSize).toBe(15);
    expect(term.options.fontFamily).toBe('"Menlo", ui-monospace, monospace');
    act(() => useThemeStore.setState({ custom: [{ ...mine, fonts: { ...mine.fonts, mono: "Courier", codeSize: 11 } }] }));
    expect(term.options.fontSize).toBe(11);
    expect(term.options.fontFamily).toBe('"Courier", ui-monospace, monospace');
    vi.unstubAllGlobals();
  });

  it.each(["windows", "linux"] as const)("on %s, sends Ctrl+N to the shell, and starts a new session on Ctrl+Shift+N", (platform) => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    useHost.setState({ ...DEFAULT_HOST, platform });
    useSettings.setState({ shortcuts: {}, keys: defaultShortcuts(platform) });
    const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
    useDesk.setState({ hub: { ptySocket: () => socket } as never });
    const newSession = vi.fn();
    renderHook(() => useAppShortcut("newSession", newSession));
    render(<Terminal sessionId="s1" />);
    const field = terms.at(-1)!.field!;
    const typed = () => socket.send.mock.calls.flatMap(([d]) => (ArrayBuffer.isView(d) ? [...(d as Uint8Array)] : []));
    const key = (init: KeyboardEventInit) => act(() => void field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })));
    key({ code: "KeyN", key: "n", ctrlKey: true });
    expect(typed()).toEqual([0x0e]);
    expect(newSession).not.toHaveBeenCalled();
    key({ code: "KeyN", key: "N", ctrlKey: true, shiftKey: true });
    expect(typed()).toEqual([0x0e]);
    expect(newSession).toHaveBeenCalledTimes(1);
    useHost.setState(DEFAULT_HOST);
    vi.unstubAllGlobals();
  });
});
