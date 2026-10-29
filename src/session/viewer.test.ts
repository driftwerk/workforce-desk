import { describe, expect, it } from "vitest";
import { type Control, type Dims, Viewer } from "./viewer";

const setup = (box: Dims | null = { cols: 100, rows: 30 }) => {
  const sent: Control[] = [];
  const sized: Dims[] = [];
  const roles: boolean[] = [];
  const pane = { box };
  const v = new Viewer({
    propose: () => pane.box,
    resize: (d) => sized.push(d),
    send: (c) => sent.push(c),
    role: (a) => roles.push(a),
  });
  return { v, sent, sized, roles, pane };
};

describe("a terminal's viewer", () => {
  it("sizes the terminal to its pane once the hub makes it active", () => {
    const { v, sent, sized, roles } = setup();
    v.opened(false);
    v.heard({ type: "size", cols: 80, rows: 24 });
    expect(sized).toEqual([{ cols: 80, rows: 24 }]);
    v.heard({ type: "role", active: true, free: false });
    expect(v.active).toBe(true);
    expect(sized.at(-1)).toEqual({ cols: 100, rows: 30 });
    expect(sent).toEqual([{ type: "resize", cols: 100, rows: 30 }]);
    expect(roles).toEqual([true]);
    // The hub echoing the size it applied doesn't resize the active viewer.
    v.heard({ type: "size", cols: 100, rows: 30 });
    expect(sized).toHaveLength(2);
  });

  it("mirrors at the active viewer's size, and asks nothing when its box changes", () => {
    const { v, sent, sized, pane, roles } = setup();
    v.opened(false);
    v.heard({ type: "role", active: false, free: false });
    v.heard({ type: "role", active: false, free: false });
    expect(roles).toEqual([false]);
    v.heard({ type: "size", cols: 120, rows: 40 });
    expect(sized).toEqual([{ cols: 120, rows: 40 }]);
    pane.box = { cols: 60, rows: 20 };
    v.boxChanged();
    expect(sent).toEqual([]);
    expect(sized).toHaveLength(1);
  });

  it("claims with the size that fits it, before its first keys reach the hub", () => {
    const { v, sent } = setup();
    v.opened(false);
    v.heard({ type: "role", active: false, free: false });
    v.claim();
    expect(sent).toEqual([{ type: "resize", cols: 100, rows: 30 }, { type: "claim" }]);
    v.heard({ type: "role", active: true, free: false });
    // Already asked for that size: nothing more to send.
    expect(sent).toHaveLength(2);
    v.claim();
    expect(sent).toHaveLength(2);
  });

  it("claims on opening only when the person is already in the pane", () => {
    const focused = setup();
    focused.v.opened(true);
    expect(focused.sent.map((c) => c.type)).toEqual(["resize", "claim"]);
    const elsewhere = setup();
    elsewhere.v.opened(false);
    expect(elsewhere.sent).toEqual([]);
  });

  it("doesn't claim or resize from a parked pane", () => {
    const { v, sent, sized, pane } = setup(null);
    v.opened(true);
    v.claim();
    expect(sent).toEqual([]);
    v.heard({ type: "role", active: true, free: false });
    expect(sent).toEqual([]);
    expect(sized).toEqual([]);
    pane.box = { cols: 90, rows: 25 };
    v.boxChanged();
    expect(sent).toEqual([{ type: "resize", cols: 90, rows: 25 }]);
  });

  it("goes back to the hub's size when another viewer takes over", () => {
    const { v, sized, roles, sent } = setup();
    v.heard({ type: "size", cols: 80, rows: 24 });
    v.heard({ type: "role", active: true, free: false });
    v.heard({ type: "role", active: false, free: false });
    expect(sized.at(-1)).toEqual({ cols: 80, rows: 24 });
    expect(roles).toEqual([true, false]);
    // Taking it back asks for its own size again.
    v.claim();
    expect(sent.slice(-2)).toEqual([{ type: "resize", cols: 100, rows: 30 }, { type: "claim" }]);
  });

  it("ignores what it doesn't understand", () => {
    const { v, sized, sent } = setup();
    v.heard(null);
    v.heard({ type: "size", cols: 0, rows: 24 });
    v.heard({ type: "other" });
    expect(sized).toEqual([]);
    expect(sent).toEqual([]);
    expect(v.active).toBe(false);
  });
});
