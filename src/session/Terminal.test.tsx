import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDesk } from "../hub/store";
import { NIGHT } from "../theme/builtin";
import { useThemeStore } from "../theme/store";
import { Terminal } from "./Terminal";

const terms: { options: Record<string, unknown> }[] = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      terms.push(this);
    }
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    resize() {}
    dispose() {}
    onData() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
  },
}));
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
});
