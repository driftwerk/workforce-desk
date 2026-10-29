import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { capture, sanitize } from "../restore/ui";
import { useUi } from "../shell/ui";
import { cssVariables, derive } from "../theme/tokens";
import { DAY, HARBOUR, NIGHT } from "../theme/builtin";
import { DEFAULT_WIDTH, GUTTER, HANDLE, MAIN_MIN, MIN_WIDTH, STEP } from "./layout";
import { SidePanel, Stage, type OpenPanel } from "./Stage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

// The stylesheet as written (Vitest hands CSS imports over empty). Node's
// types aren't in this project's, so it's reached untyped.
const fs = (await import("node:fs" as string)) as { readFileSync: (path: string, enc: "utf8") => string };
const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
const css = fs.readFileSync(`${cwd}/src/styles/panels.css`, "utf8");

/** The row the main area and columns share, as wide as the test says. */
let rowWidth = 1600;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("stage-row") ? rowWidth : 0;
    },
  });
  // jsdom has neither pointer events nor pointer capture.
  if (!("PointerEvent" in window)) {
    class PointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.assign(window, { PointerEvent });
  }
  const captured = new WeakSet<Element>();
  Object.assign(HTMLElement.prototype, {
    setPointerCapture(this: HTMLElement) {
      captured.add(this);
    },
    releasePointerCapture(this: HTMLElement) {
      captured.delete(this);
    },
    hasPointerCapture(this: HTMLElement) {
      return captured.has(this);
    },
  });
});

beforeEach(() => {
  rowWidth = 1600;
  useUi.setState({ panelWidths: {}, panelFocus: null });
});
afterEach(cleanup);

/** Counts how often what a panel shows mounts: a terminal mounting again
 *  would reconnect. */
const mounts: Record<string, number> = {};
function Body({ id }: { id: string }) {
  useEffect(() => {
    mounts[id] = (mounts[id] ?? 0) + 1;
  }, [id]);
  return <div data-testid={`body-${id}`}>{id}</div>;
}

const thread: OpenPanel = {
  kind: "thread",
  label: "Thread",
  element: (
    <SidePanel label="Thread" noun="the thread" title={<b>Thread</b>} onClose={() => undefined}>
      <Body id="thread" />
    </SidePanel>
  ),
};
const closeSession = vi.fn();
const session: OpenPanel = {
  kind: "session",
  label: "web-release",
  element: (
    <SidePanel label="Session web-release" noun="this session" title={<b>web-release</b>} onClose={closeSession}>
      <div className="terminal-frame">
        <textarea aria-label="Terminal input" />
      </div>
      <Body id="session" />
    </SidePanel>
  ),
};

function Shell({ panels = [thread, session], mainKey = "room:r1", main }: { panels?: OpenPanel[]; mainKey?: string; main?: ReactNode }) {
  return <Stage mainKey={mainKey} mainName="Driftwerk" panels={panels} main={main ?? <main aria-label="Room Driftwerk">Driftwerk</main>} />;
}

const slot = (kind: string) => document.querySelector<HTMLElement>(`[data-panel="${kind}"]`)!;
const handle = (label: string) => screen.getByRole("separator", { name: `Resize ${label}` });
const widthOf = (kind: string) => parseInt(slot(kind).style.width, 10);
const space = (n: number) => rowWidth - GUTTER - n * HANDLE;

describe("resizing a column", () => {
  it("drags its left edge, within the minimum and leaving the main area its share, and keeps the width per kind", () => {
    render(<Shell />);
    const h = handle("web-release");
    expect(h.getAttribute("aria-orientation")).toBe("vertical");
    expect(h.getAttribute("aria-valuenow")).toBe(String(DEFAULT_WIDTH.session));
    expect(h.tabIndex).toBe(0);

    fireEvent.pointerDown(h, { clientX: 1000, button: 0, pointerId: 1 });
    fireEvent.pointerMove(h, { clientX: 900, pointerId: 1 });
    // Drawn at once, kept only when let go.
    expect(widthOf("session")).toBe(DEFAULT_WIDTH.session + 100);
    expect(useUi.getState().panelWidths).toEqual({});
    fireEvent.pointerMove(h, { clientX: -5000, pointerId: 1 });
    fireEvent.pointerUp(h, { clientX: -5000, pointerId: 1 });
    const max = space(2) - MAIN_MIN - DEFAULT_WIDTH.thread;
    expect(useUi.getState().panelWidths).toEqual({ session: max });
    expect(h.getAttribute("aria-valuenow")).toBe(String(max));
    expect(h.getAttribute("aria-valuemax")).toBe(String(max));

    fireEvent.pointerDown(h, { clientX: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(h, { clientX: 5000, pointerId: 1 });
    fireEvent.pointerUp(h, { clientX: 5000, pointerId: 1 });
    expect(useUi.getState().panelWidths).toEqual({ session: MIN_WIDTH });
    // The other column wasn't touched.
    expect(widthOf("thread")).toBe(DEFAULT_WIDTH.thread);
    // Kept in ui.main, so it's there after a restart.
    expect(capture().panelWidths).toEqual({ session: MIN_WIDTH });
    expect(sanitize({ panelWidths: { session: 640, thread: 5, nope: 400 } }).panelWidths).toEqual({ session: 640 });
  });

  it("moves 24px a key press, and double-click puts the default back", () => {
    render(<Shell />);
    const h = handle("Thread");
    fireEvent.keyDown(h, { key: "ArrowLeft" });
    expect(useUi.getState().panelWidths.thread).toBe(DEFAULT_WIDTH.thread + STEP);
    expect(h.getAttribute("aria-valuenow")).toBe(String(DEFAULT_WIDTH.thread + STEP));
    fireEvent.keyDown(h, { key: "ArrowRight" });
    fireEvent.keyDown(h, { key: "ArrowRight" });
    expect(useUi.getState().panelWidths.thread).toBe(DEFAULT_WIDTH.thread - STEP);
    for (let i = 0; i < 20; i++) fireEvent.keyDown(h, { key: "ArrowRight" });
    expect(useUi.getState().panelWidths.thread).toBe(MIN_WIDTH);
    fireEvent.doubleClick(h);
    expect(useUi.getState().panelWidths).toEqual({});
    expect(widthOf("thread")).toBe(DEFAULT_WIDTH.thread);
  });

  it("shrinks the columns in proportion in a narrower window, never overflowing, and gives the widths back", () => {
    useUi.setState({ panelWidths: { thread: 500, session: 700 } });
    rowWidth = 1200;
    render(<Shell />);
    const narrow = [widthOf("thread"), widthOf("session")];
    expect(narrow[0]! + narrow[1]!).toBeLessThanOrEqual(space(2) - MAIN_MIN);
    expect(narrow[1]! / narrow[0]!).toBeCloseTo(700 / 500, 1);
    // What was chosen is still what's kept.
    expect(useUi.getState().panelWidths).toEqual({ thread: 500, session: 700 });
    rowWidth = 2400;
    cleanup();
    render(<Shell />);
    expect([widthOf("thread"), widthOf("session")]).toEqual([500, 700]);
  });
});

describe("focusing a panel", () => {
  it("fills the main area with it, and going back puts everything exactly as it was, without remounting", () => {
    useUi.setState({ panelWidths: { thread: 360 } });
    render(<Shell />);
    const before = { mounts: { ...mounts }, thread: widthOf("thread"), session: widthOf("session") };
    fireEvent.click(screen.getByRole("button", { name: "Focus this session" }));
    expect(useUi.getState().panelFocus).toEqual({ kind: "session", beside: null });
    expect(slot("session").className).toContain("rpanel-focused");
    expect(document.querySelector(".stage-main")!.className).toContain("stowed");
    expect(screen.queryByRole("separator", { name: "Resize web-release" })).toBeNull();
    // What the main area showed is the way back.
    const crumb = screen.getByRole("button", { name: "Back to Driftwerk" });
    expect(crumb.textContent).toContain("Driftwerk");
    expect(screen.getByRole("button", { name: "Back to a side panel" }).title).toContain("Esc");
    // Kept in ui.main, so it's there after a restart.
    expect(capture().panelFocus).toEqual({ kind: "session", beside: null });

    fireEvent.click(screen.getByRole("button", { name: "Back to a side panel" }));
    expect(useUi.getState().panelFocus).toBeNull();
    expect([widthOf("thread"), widthOf("session")]).toEqual([before.thread, before.session]);
    expect(document.querySelector(".stage-main")!.className).not.toContain("stowed");
    expect(slot("thread").className).toContain("rpanel-column");

    fireEvent.click(screen.getByRole("button", { name: "Focus the thread" }));
    fireEvent.click(crumb.isConnected ? crumb : screen.getByRole("button", { name: "Back to Driftwerk" }));
    expect(useUi.getState().panelFocus).toBeNull();
    expect(mounts).toEqual(before.mounts);
  });

  it("folds the other panels into tabs, and a tab opens beside the focused view", () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Focus this session" }));
    const dock = screen.getByRole("navigation", { name: "Other panels" });
    const tab = within(dock).getByRole("button", { name: "Thread" });
    expect(tab.getAttribute("aria-pressed")).toBe("false");
    expect(slot("thread").className).toContain("stowed");
    expect(slot("thread").getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(tab);
    expect(useUi.getState().panelFocus).toEqual({ kind: "session", beside: "thread" });
    expect(tab.getAttribute("aria-pressed")).toBe("true");
    expect(slot("thread").className).toContain("rpanel-column");
    // Beside the focused one, it's a column like any other.
    expect(handle("Thread")).toBeTruthy();

    fireEvent.click(tab);
    expect(useUi.getState().panelFocus).toEqual({ kind: "session", beside: null });

    // Closing the focused panel goes back.
    fireEvent.click(screen.getByRole("button", { name: "Close this session" }));
    expect(closeSession).toHaveBeenCalled();
    expect(useUi.getState().panelFocus).toBeNull();
  });

  it("goes back on Esc, unless Esc was the terminal's or something nearer took it", () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Focus this session" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Terminal input" }), { key: "Escape" });
    expect(useUi.getState().panelFocus).not.toBeNull();
    const taken = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    taken.preventDefault();
    act(() => void window.dispatchEvent(taken));
    expect(useUi.getState().panelFocus).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useUi.getState().panelFocus).toBeNull();
  });

  it("brings the main area back when it's given something else to show", () => {
    const { rerender } = render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Focus the thread" }));
    rerender(<Shell mainKey="room:r2" />);
    expect(useUi.getState().panelFocus).toBeNull();
  });

  it("is no focus while its panel isn't open, and ends when the panel closes", () => {
    useUi.setState({ panelFocus: { kind: "session", beside: null } });
    const { rerender } = render(<Shell panels={[thread]} />);
    expect(document.querySelector(".stage-main")!.className).not.toContain("stowed");
    // Put back on launch: the session shows once the hub lists it.
    rerender(<Shell panels={[thread, session]} />);
    expect(slot("session").className).toContain("rpanel-focused");
    rerender(<Shell panels={[thread]} />);
    expect(useUi.getState().panelFocus).toBeNull();
  });
});

describe("the drag handles' colours", () => {
  const rules = (selector: RegExp) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel]) => selector.test(sel!)).map(([, , body]) => body!);

  it("come from the theme's handle tokens, with no colour written in", () => {
    const grip = rules(/rpanel-grip/).join("\n");
    expect(grip).toMatch(/background:\s*var\(--handle\)/);
    expect(grip).toMatch(/background:\s*var\(--handle-active\)/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgba?|hsla?|oklch|lab|lch)\(/i);
    for (const body of rules(/./)) {
      for (const [, value] of body.matchAll(/(?:^|;)\s*(?:background|color|border(?:-[a-z]+)*|outline)\s*:\s*([^;]+)/g)) {
        expect(value, value).toMatch(/var\(--|transparent|none|^0|^\d|solid|inherit/);
      }
    }
  });

  it("are tokens every theme has, following its border and signal unless it sets them", () => {
    for (const t of [NIGHT, DAY, HARBOUR]) {
      const theme = derive(t);
      const vars = cssVariables(theme);
      expect(vars["--handle"]).toBe(theme.colors.border);
      expect(vars["--handle-active"]).toBe(theme.colors.signal);
    }
    const custom = derive({ ...NIGHT, overrides: { border: "#333333", handleActive: "#FF00AA" } });
    expect(custom.colors.handle).toBe("#333333");
    expect(custom.colors.handleActive).toBe("#FF00AA");
  });
});
