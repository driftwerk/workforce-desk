import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { between, clearSelection, followOpen, extend, inBulk, isBulk, keepOnly, modHeld, only, pickOf, selectAll, showRows, toggle, typedIn, useSelection } from "./selection";

const ORDER = ["session:a", "session:b", "session:devbox/c", "agent:local/d", "session:e"];
const picked = () => [...useSelection.getState().keys];

beforeEach(() => showRows(ORDER));
afterEach(() => {
  clearSelection();
  showRows([]);
});

describe("picking rows in the sidebar", () => {
  it("picks a range from the last row picked, either way, as the sidebar shows them", () => {
    expect(between(ORDER, "session:b", "agent:local/d")).toEqual(["session:b", "session:devbox/c", "agent:local/d"]);
    expect(between(ORDER, "agent:local/d", "session:b")).toEqual(["session:b", "session:devbox/c", "agent:local/d"]);
    expect(between(ORDER, null, "session:e")).toEqual(["session:e"]);
    expect(between(ORDER, "session:gone", "session:a")).toEqual(["session:a"]);
    expect(between(ORDER, "session:a", "session:gone")).toEqual([]);
  });

  it("picks one row alone, letting go of the rest", () => {
    toggle("session:a");
    toggle("session:b");
    only("session:e");
    expect(picked()).toEqual(["session:e"]);
    expect(useSelection.getState().anchor).toBe("session:e");
    extend("session:devbox/c");
    expect(picked().sort()).toEqual(["agent:local/d", "session:devbox/c", "session:e"]);
  });

  it("toggles one row and extends from it, keeping what was picked", () => {
    toggle("session:a");
    extend("session:devbox/c");
    expect(picked()).toEqual(["session:a", "session:b", "session:devbox/c"]);
    toggle("session:b");
    expect(picked()).toEqual(["session:a", "session:devbox/c"]);
    expect(useSelection.getState().anchor).toBe("session:b");
    extend("agent:local/d");
    expect(picked().sort()).toEqual(["agent:local/d", "session:a", "session:b", "session:devbox/c"]);
  });

  it("redraws the range from the anchor on each shift-click, so it shrinks as well as grows", () => {
    toggle("session:a");
    toggle("session:devbox/c");
    extend("session:e");
    expect(picked().sort()).toEqual(["agent:local/d", "session:a", "session:devbox/c", "session:e"]);
    extend("agent:local/d");
    expect(picked().sort()).toEqual(["agent:local/d", "session:a", "session:devbox/c"]);
    extend("session:b");
    expect(picked().sort()).toEqual(["session:a", "session:b", "session:devbox/c"]);
  });

  it("starts a range at the row shift-clicked when nothing is picked", () => {
    extend("session:b");
    expect(picked()).toEqual(["session:b"]);
    extend("session:devbox/c");
    expect(picked()).toEqual(["session:b", "session:devbox/c"]);
  });

  it("picks every row shown, or those it's given", () => {
    selectAll();
    expect(picked()).toEqual(ORDER);
    selectAll(["session:b", "session:e"]);
    expect(picked()).toEqual(["session:b", "session:e"]);
    expect(useSelection.getState().anchor).toBe("session:b");
    selectAll([]);
    expect(picked()).toEqual([]);
  });

  it("acts on rows together only when two or more are picked", () => {
    only("session:a");
    expect(isBulk(useSelection.getState())).toBe(false);
    expect(inBulk("session:a")).toBe(false);
    toggle("session:b");
    expect(isBulk(useSelection.getState())).toBe(true);
    expect(inBulk("session:a")).toBe(true);
    expect(inBulk("session:e")).toBe(false);
  });

  it("takes shift for a range and the platform's own modifier for one row; a plain click picks the row alone", () => {
    const click = (m: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }>) => ({ shiftKey: false, metaKey: false, ctrlKey: false, ...m });
    expect(pickOf(click({ shiftKey: true }), "macos")).toBe("range");
    expect(pickOf(click({ metaKey: true }), "macos")).toBe("toggle");
    expect(pickOf(click({ ctrlKey: true }), "macos")).toBeNull();
    expect(pickOf(click({ ctrlKey: true }), "windows")).toBe("toggle");
    expect(pickOf(click({ ctrlKey: true }), "linux")).toBe("toggle");
    expect(pickOf(click({ metaKey: true }), "windows")).toBeNull();
    expect(pickOf(click({}), "macos")).toBeNull();
    expect(modHeld({ metaKey: true, ctrlKey: false }, "macos")).toBe(true);
    expect(modHeld({ metaKey: false, ctrlKey: true }, "windows")).toBe(true);
    expect(modHeld({ metaKey: true, ctrlKey: false }, "linux")).toBe(false);
  });

  it("lets go of rows gone from sight, and keeps the same selection when none went", () => {
    toggle("session:a");
    toggle("session:b");
    const before = useSelection.getState();
    keepOnly(() => true);
    expect(useSelection.getState()).toBe(before);
    showRows(["session:a", "session:e"]);
    expect(picked()).toEqual(["session:a"]);
    expect(useSelection.getState().anchor).toBeNull();
    expect([...useSelection.getState().base]).toEqual(["session:a"]);
    extend("session:e");
    expect(picked()).toEqual(["session:a", "session:e"]);
  });

  it("lets go back to the open row alone, so the next ⌘-click adds to it", () => {
    followOpen("session:b");
    toggle("session:a");
    toggle("session:e");
    clearSelection();
    expect(picked()).toEqual(["session:b"]);
    expect(useSelection.getState().anchor).toBe("session:b");
    const same = useSelection.getState();
    clearSelection();
    expect(useSelection.getState()).toBe(same);
    toggle("session:b");
    expect(picked()).toEqual([]);
    followOpen(null);
  });

  it("clears the picks, and leaves an empty selection as it is", () => {
    toggle("session:a");
    clearSelection();
    expect(picked()).toEqual([]);
    expect(useSelection.getState().anchor).toBeNull();
    const empty = useSelection.getState();
    clearSelection();
    expect(useSelection.getState()).toBe(empty);
  });

  it("leaves Escape and ⌘A to fields, terminals and dialogs", () => {
    document.body.innerHTML = `<input id="f"><div class="xterm"><textarea id="t"></textarea></div><div role="dialog"><button id="d"></button></div><nav><button id="row"></button></nav><div contenteditable="true"><span id="e"></span></div>`;
    const at = (id: string) => document.getElementById(id);
    expect(["f", "t", "d", "e"].map((id) => typedIn(at(id)))).toEqual([true, true, true, true]);
    expect(typedIn(at("row"))).toBe(false);
    expect(typedIn(null)).toBe(false);
    document.body.innerHTML = "";
  });
});
