import { afterEach, describe, expect, it } from "vitest";
import { between, clearSelection, extend, keepOnly, pickOf, startSelecting, toggle, typedIn, useSelection } from "./selection";

const ORDER = ["session:a", "session:b", "session:devbox/c", "session:d", "session:e"];
const picked = () => [...useSelection.getState().keys];

afterEach(clearSelection);

describe("picking sessions in the sidebar", () => {
  it("picks a range from the last row picked, either way, as the sidebar shows them", () => {
    expect(between(ORDER, "session:b", "session:d")).toEqual(["session:b", "session:devbox/c", "session:d"]);
    expect(between(ORDER, "session:d", "session:b")).toEqual(["session:b", "session:devbox/c", "session:d"]);
    expect(between(ORDER, null, "session:e")).toEqual(["session:e"]);
    expect(between(ORDER, "session:gone", "session:a")).toEqual(["session:a"]);
    expect(between(ORDER, "session:a", "session:gone")).toEqual([]);
  });

  it("toggles one row and extends from it, keeping what was picked", () => {
    toggle("session:a");
    extend(ORDER, "session:devbox/c");
    expect(picked()).toEqual(["session:a", "session:b", "session:devbox/c"]);
    toggle("session:b");
    expect(picked()).toEqual(["session:a", "session:devbox/c"]);
    expect(useSelection.getState().anchor).toBe("session:b");
    extend(ORDER, "session:d");
    expect(picked().sort()).toEqual(["session:a", "session:b", "session:d", "session:devbox/c"]);
  });

  it("takes shift for a range and the platform's own modifier for one row, a plain click only in select mode", () => {
    const click = (m: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }>) => ({ shiftKey: false, metaKey: false, ctrlKey: false, ...m });
    expect(pickOf(click({ shiftKey: true }), "macos", false)).toBe("range");
    expect(pickOf(click({ metaKey: true }), "macos", false)).toBe("toggle");
    expect(pickOf(click({ ctrlKey: true }), "macos", false)).toBeNull();
    expect(pickOf(click({ ctrlKey: true }), "windows", false)).toBe("toggle");
    expect(pickOf(click({ ctrlKey: true }), "linux", false)).toBe("toggle");
    expect(pickOf(click({ metaKey: true }), "windows", false)).toBeNull();
    expect(pickOf(click({}), "macos", false)).toBeNull();
    expect(pickOf(click({}), "windows", true)).toBe("toggle");
  });

  it("lets go of rows gone from the sidebar and keeps the same selection when none went", () => {
    toggle("session:a");
    toggle("session:b");
    const before = useSelection.getState();
    keepOnly(() => true);
    expect(useSelection.getState()).toBe(before);
    keepOnly((k) => k !== "session:b");
    expect(picked()).toEqual(["session:a"]);
    expect(useSelection.getState().anchor).toBeNull();
  });

  it("clears the picks and select mode at once", () => {
    startSelecting();
    toggle("session:a");
    clearSelection();
    expect(useSelection.getState()).toMatchObject({ selecting: false, anchor: null });
    expect(picked()).toEqual([]);
  });

  it("leaves Escape to fields, terminals and dialogs", () => {
    document.body.innerHTML = `<input id="f"><div class="xterm"><textarea id="t"></textarea></div><div role="dialog"><button id="d"></button></div><nav><button id="row"></button></nav><div contenteditable="true"><span id="e"></span></div>`;
    const at = (id: string) => document.getElementById(id);
    expect(["f", "t", "d", "e"].map((id) => typedIn(at(id)))).toEqual([true, true, true, true]);
    expect(typedIn(at("row"))).toBe(false);
    expect(typedIn(null)).toBe(false);
    document.body.innerHTML = "";
  });
});
