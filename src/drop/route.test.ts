import { afterEach, describe, expect, it, vi } from "vitest";
import { DropRouter, registerZone, toCss, useDropOver, ZONE_ATTR, zoneAt } from "./route";

afterEach(() => {
  document.body.innerHTML = "";
  useDropOver.setState({ over: null });
});

/** A page with a session's pane, a conversation inside a grid pane, and a
 *  sidebar, each element found at a point as laid out. */
const page = () => {
  document.body.innerHTML = `
    <nav id="sidebar"><div id="row">Ada</div></nav>
    <div id="pane" ${ZONE_ATTR}="t1"><div id="xterm"><textarea id="field"></textarea></div></div>
    <div id="dialog" role="dialog">Rename</div>
    <div id="room" ${ZONE_ATTR}="c1"><div id="thread" ${ZONE_ATTR}="c2"><p id="msg">hi</p></div></div>`;
  const at: Record<string, string[]> = {
    "10,10": ["row", "sidebar"],
    "300,200": ["field", "xterm", "pane"],
    "700,200": ["msg", "thread", "room"],
    "700,50": ["room"],
    "320,220": ["dialog", "field", "xterm", "pane"],
  };
  document.elementsFromPoint = (x: number, y: number) => (at[`${x},${y}`] ?? []).map((id) => document.getElementById(id)!);
};

describe("a drop of files, routed by where it lands", () => {
  it("goes to the innermost zone under the pointer, and nowhere else", () => {
    page();
    const pane = vi.fn();
    const room = vi.fn();
    const thread = vi.fn();
    const offs = [registerZone("t1", { label: "session", drop: pane }), registerZone("c1", { label: "c", drop: room }), registerZone("c2", { label: "c", drop: thread })];
    const router = new DropRouter((p) => zoneAt(p.x, p.y));
    router.handle({ type: "enter", paths: ["/a.png"], position: { x: 300, y: 200 } });
    expect(useDropOver.getState().over).toBe("t1");
    router.handle({ type: "over", position: { x: 700, y: 200 } });
    expect(useDropOver.getState().over).toBe("c2");
    router.handle({ type: "over", position: { x: 700, y: 50 } });
    expect(useDropOver.getState().over).toBe("c1");
    router.handle({ type: "drop", paths: ["/a.png", "/b c.png"], position: { x: 300, y: 200 } });
    expect(pane).toHaveBeenCalledWith(["/a.png", "/b c.png"]);
    expect(room).not.toHaveBeenCalled();
    expect(thread).not.toHaveBeenCalled();
    expect(useDropOver.getState().over).toBeNull();
    router.handle({ type: "drop", paths: ["/x"], position: { x: 700, y: 200 } });
    expect(thread).toHaveBeenCalledWith(["/x"]);
    expect(room).not.toHaveBeenCalled();
    offs.forEach((off) => off());
  });

  it("is given to nothing over the sidebar or outside every zone", () => {
    page();
    const pane = vi.fn();
    const off = registerZone("t1", { label: "session", drop: pane });
    const router = new DropRouter((p) => zoneAt(p.x, p.y));
    router.handle({ type: "enter", paths: ["/a.png"], position: { x: 10, y: 10 } });
    expect(useDropOver.getState().over).toBeNull();
    router.handle({ type: "drop", paths: ["/a.png"], position: { x: 10, y: 10 } });
    router.handle({ type: "drop", paths: ["/a.png"], position: { x: 999, y: 999 } });
    expect(pane).not.toHaveBeenCalled();
    off();
  });

  it("ignores something dragged that carries no files, as an image dragged within the page", () => {
    page();
    const pane = vi.fn();
    const off = registerZone("t1", { label: "session", drop: pane });
    const router = new DropRouter((p) => zoneAt(p.x, p.y));
    router.handle({ type: "enter", paths: [], position: { x: 300, y: 200 } });
    router.handle({ type: "over", position: { x: 300, y: 200 } });
    expect(useDropOver.getState().over).toBeNull();
    router.handle({ type: "drop", paths: [], position: { x: 300, y: 200 } });
    expect(pane).not.toHaveBeenCalled();
    off();
  });

  it("stops showing where it would land when the drag leaves the window", () => {
    page();
    const off = registerZone("t1", { label: "session", drop: vi.fn() });
    const router = new DropRouter((p) => zoneAt(p.x, p.y));
    router.handle({ type: "enter", paths: ["/a"], position: { x: 300, y: 200 } });
    router.handle({ type: "leave" });
    expect(useDropOver.getState().over).toBeNull();
    off();
  });

  it("is given to nothing when a dialog over a pane is what's under the pointer", () => {
    page();
    const pane = vi.fn();
    const off = registerZone("t1", { label: "session", drop: pane });
    const router = new DropRouter((p) => zoneAt(p.x, p.y));
    router.handle({ type: "enter", paths: ["/a.png"], position: { x: 320, y: 220 } });
    expect(useDropOver.getState().over).toBeNull();
    router.handle({ type: "drop", paths: ["/a.png"], position: { x: 320, y: 220 } });
    expect(pane).not.toHaveBeenCalled();
    off();
  });

  it("a zone gone (its pane closed) takes nothing", () => {
    page();
    const pane = vi.fn();
    registerZone("t1", { label: "session", drop: pane })();
    expect(zoneAt(300, 200)).toBeNull();
  });
});

describe("a drop's position", () => {
  it("is the page's own on macOS and Linux, and scaled from the device's pixels on Windows", () => {
    expect(toCss({ x: 300, y: 200 }, "macos", 2)).toEqual({ x: 300, y: 200 });
    expect(toCss({ x: 300, y: 200 }, "linux", 2)).toEqual({ x: 300, y: 200 });
    expect(toCss({ x: 600, y: 400 }, "windows", 2)).toEqual({ x: 300, y: 200 });
    expect(toCss({ x: 450, y: 300 }, "windows", 1.5)).toEqual({ x: 300, y: 200 });
  });
});
