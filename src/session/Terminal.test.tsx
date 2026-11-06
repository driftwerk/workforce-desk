import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import { useSettings } from "../settings/store";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { defaultShortcuts } from "../shortcuts/keys";
import { useAppShortcut } from "../shortcuts/manager";
import { NIGHT } from "../theme/builtin";
import { useThemeStore } from "../theme/store";
import { EMOJI_STACK } from "../theme/tokens";
import { askNatively, openUrl } from "../platform";
import { Terminal, linkAction, reattachPrefix, terminalLinks } from "./Terminal";

const terms: { options: Record<string, unknown>; field?: HTMLTextAreaElement; written: string[]; resets: number }[] = [];
vi.mock("@xterm/xterm", () => ({
  // Like xterm: its text field takes the keys, and a key the custom handler
  // doesn't keep back is typed (Ctrl and a letter as its control character).
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    field?: HTMLTextAreaElement;
    written: string[] = [];
    resets = 0;
    buffer = { active: { type: "normal" } };
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
    write(d: unknown) {
      if (typeof d === "string") this.written.push(d);
    }
    reset() {
      this.resets++;
    }
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
vi.mock("../platform", async (real) => ({ ...(await real<typeof import("../platform")>()), openUrl: vi.fn(), askNatively: vi.fn(async () => false) }));

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
    expect(term.options.fontFamily).toBe(`"Menlo", ui-monospace, monospace, ${EMOJI_STACK}`);
    act(() => useThemeStore.setState({ custom: [{ ...mine, fonts: { ...mine.fonts, mono: "Courier", codeSize: 11 } }] }));
    expect(term.options.fontSize).toBe(11);
    expect(term.options.fontFamily).toBe(`"Courier", ui-monospace, monospace, ${EMOJI_STACK}`);
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

  it("on linux, sends Ctrl+R to the shell and doesn't reload Desk, which takes Ctrl+Shift+R", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    useHost.setState({ ...DEFAULT_HOST, platform: "linux" });
    useSettings.setState({ shortcuts: {}, keys: defaultShortcuts("linux") });
    const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
    useDesk.setState({ hub: { ptySocket: () => socket } as never });
    const reload = vi.fn();
    renderHook(() => useAppShortcut("reload", reload));
    render(<Terminal sessionId="s1" />);
    const field = terms.at(-1)!.field!;
    const typed = () => socket.send.mock.calls.flatMap(([d]) => (ArrayBuffer.isView(d) ? [...(d as Uint8Array)] : []));
    const key = (init: KeyboardEventInit) => act(() => void field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })));
    key({ code: "KeyR", key: "r", ctrlKey: true });
    expect(typed()).toEqual([0x12]);
    expect(reload).not.toHaveBeenCalled();
    key({ code: "KeyR", key: "R", ctrlKey: true, shiftKey: true });
    expect(reload).toHaveBeenCalledTimes(1);
    useHost.setState(DEFAULT_HOST);
    vi.unstubAllGlobals();
  });
});

/** A socket as the page holds one, its handlers called by the test. */
interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onopen?: (() => void) | null;
  onclose?: ((e: { code: number }) => void) | null;
}

/** A hub whose sockets are kept in `sockets`, and whose lists answer
 *  `listed()` (throwing: the hub can't be reached). */
const fakeHub = (listed: () => Promise<unknown[]>) => {
  const sockets: FakeSocket[] = [];
  const made = (): FakeSocket => {
    const s: FakeSocket = { readyState: 0, send: vi.fn(), close: vi.fn() };
    sockets.push(s);
    return s;
  };
  const hub = { ptySocket: vi.fn(made), terminalSocket: vi.fn(made), sessions: vi.fn(listed), terminals: vi.fn(listed) };
  return { hub, sockets };
};

const opened = (s: FakeSocket | undefined) =>
  act(() => {
    if (!s) throw new Error("no socket");
    s.readyState = WebSocket.OPEN;
    s.onopen?.();
  });
const closed = (s: FakeSocket | undefined, code: number) =>
  act(() => {
    if (!s) throw new Error("no socket");
    s.readyState = WebSocket.CLOSED;
    s.onclose?.({ code });
  });
const later = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const shown = () => terms.at(-1)!.written.join("");

describe("a terminal whose hub goes away", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says it is reconnecting, and attaches to the same session again once the hub is back", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let up = false;
    const { hub, sockets } = fakeHub(async () => {
      if (!up) throw new Error("Desk couldn't reach this computer's hub");
      return [{ id: "s1", live: true }];
    });
    useDesk.setState({ hub: hub as never });
    render(<Terminal sessionId="s1" />);
    opened(sockets[0]);
    // The hub stopped: the socket dropped, no close frame (1006).
    closed(sockets[0], 1006);
    expect(shown()).toContain("reconnecting");
    expect(shown()).not.toContain("detached");
    // Unreachable: asked again later and later, with no socket meanwhile.
    await later(500);
    await later(1000);
    await later(2000);
    expect(hub.sessions).toHaveBeenCalledTimes(3);
    expect(sockets).toHaveLength(1);
    up = true;
    await later(4000);
    expect(sockets).toHaveLength(2);
    expect(hub.ptySocket).toHaveBeenLastCalledWith("s1");
    // The old output is kept: pushed up into the scrollback under a line
    // that says so, and the hub's replay drawn below it from the top.
    const before = terms.at(-1)!.written.length;
    opened(sockets[1]);
    expect(terms.at(-1)!.resets).toBe(0);
    const prefix = terms.at(-1)!.written.slice(before).join("");
    expect(prefix).toBe(reattachPrefix(24));
    expect(prefix).not.toMatch(/\x1bc|\x1b\[3J|\x1b\[2J/);
    // Once it has stayed up a while, a drop starts over from the shortest wait.
    await later(5000);
    closed(sockets[1], 1006);
    await later(500);
    expect(sockets).toHaveLength(3);
  });

  it("waits longer each time a socket opens and drops at once, rather than every half second", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const { hub, sockets } = fakeHub(async () => [{ id: "t1", live: true }]);
    useDesk.setState({ hub: hub as never });
    render(<Terminal terminalId="t1" />);
    opened(sockets[0]);
    closed(sockets[0], 1006);
    for (const [wait, n] of [
      [500, 2],
      [1000, 3],
      [2000, 4],
    ] as const) {
      await later(wait - 1);
      expect(sockets).toHaveLength(n - 1);
      await later(1);
      expect(sockets).toHaveLength(n);
      opened(sockets[n - 1]);
      closed(sockets[n - 1], 1006);
    }
    // Said once, however often it flaps.
    expect(shown().match(/reconnecting/g)).toHaveLength(1);
  });

  it("keeps trying while the hub is away, never waiting more than ten seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const { hub, sockets } = fakeHub(() => Promise.reject(new Error("unreachable")));
    useDesk.setState({ hub: hub as never });
    render(<Terminal terminalId="t1" />);
    closed(sockets[0], 1006);
    await later(500 + 1000 + 2000 + 4000 + 8000);
    expect(hub.terminals).toHaveBeenCalledTimes(5);
    await later(10_000 * 20);
    expect(hub.terminals).toHaveBeenCalledTimes(25);
    expect(shown()).not.toContain("terminal closed");
  });

  it("stops trying once unmounted", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const { hub, sockets } = fakeHub(async () => [{ id: "t1", live: true }]);
    useDesk.setState({ hub: hub as never });
    const { unmount } = render(<Terminal terminalId="t1" />);
    closed(sockets[0], 1006);
    unmount();
    await later(60_000);
    expect(hub.terminals).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });
});

describe("a terminal that ended", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says so when the hub closes it, and doesn't try again", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const { hub, sockets } = fakeHub(async () => [{ id: "t1", live: true }]);
    useDesk.setState({ hub: hub as never });
    render(<Terminal terminalId="t1" />);
    opened(sockets[0]);
    // The hub's close frame has no code (1005).
    closed(sockets[0], 1005);
    expect(shown()).toContain("terminal closed");
    expect(shown()).not.toContain("reconnecting");
    await later(60_000);
    expect(sockets).toHaveLength(1);
    expect(hub.terminals).not.toHaveBeenCalled();
  });

  it("says so when the hub comes back without it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const { hub, sockets } = fakeHub(async () => [{ id: "t2", live: true }, { id: "t1", live: false }]);
    useDesk.setState({ hub: hub as never });
    render(<Terminal terminalId="t1" />);
    closed(sockets[0], 1006);
    await later(500);
    expect(shown()).toContain("terminal closed");
    await later(60_000);
    expect(sockets).toHaveLength(1);
    expect(hub.terminals).toHaveBeenCalledTimes(1);
  });
});


describe("a link in a terminal", () => {
  it("opens an http(s) page in the browser, never through the page's confirm or window.open", () => {
    const confirm = vi.spyOn(window, "confirm");
    const open = vi.spyOn(window, "open");
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const socket = { readyState: 0, send: vi.fn(), close: vi.fn() };
    useDesk.setState({ hub: { ptySocket: () => socket } as never });
    render(<Terminal sessionId="s1" />);
    // xterm is given the handler: its own default would confirm() and window.open().
    expect(terms.at(-1)!.options.linkHandler).toBe(terminalLinks);
    const page = "https://claude.com/cai/oauth/authorize?code=true&state=s";
    terminalLinks.activate(new MouseEvent("click"), page);
    expect(openUrl).toHaveBeenCalledWith(page);
    for (const other of ["file:///etc/passwd", "javascript:alert(1)", "ssh://devbox", "not a link"]) terminalLinks.activate(new MouseEvent("click"), other);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(terminalLinks.allowNonHttpProtocols).toBe(false);
    vi.unstubAllGlobals();
  });

  it("opens only Claude's and OpenAI's sign-in pages at once, asks about others by their real address, and never opens local ones", async () => {
    for (const page of ["https://claude.ai/oauth/authorize?x=1", "https://auth.openai.com/codex/device", "https://console.anthropic.com/x"])
      expect(linkAction(page)).toEqual({ kind: "open", url: page });
    expect(linkAction("https://claude.ai.evil.example/x").kind).toBe("ask");
    expect(linkAction("http://claude.ai/x").kind).toBe("ask");
    expect(linkAction("https://example.com/claude.ai")).toEqual({ kind: "ask", url: "https://example.com/claude.ai" });
    for (const local of [
      "http://localhost:3000/",
      "http://127.0.0.1:8080/api",
      "http://[::1]/",
      "http://10.0.3.14/",
      "http://192.168.1.1/",
      "http://172.20.0.2/",
      "http://169.254.169.254/latest/meta-data",
      "http://devbox/",
      "http://printer.local/",
      "https://user:pw@claude.ai/",
    ])
      expect(linkAction(local), local).toEqual({ kind: "refuse" });

    const ask = vi.mocked(askNatively);
    vi.mocked(openUrl).mockClear();
    ask.mockResolvedValueOnce(false);
    terminalLinks.activate(new MouseEvent("click"), "https://example.com/page");
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask.mock.calls[0]![1]).toContain("https://example.com/page");
    await Promise.resolve();
    expect(openUrl).not.toHaveBeenCalled();
    ask.mockResolvedValueOnce(true);
    terminalLinks.activate(new MouseEvent("click"), "https://example.com/page");
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/page"));
    terminalLinks.activate(new MouseEvent("click"), "http://127.0.0.1:9/");
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
