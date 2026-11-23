import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSelection, showRows, useSelection } from "../groups/selection";
import { registerTerminal, selectAllAt } from "./selectAll";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

afterEach(() => {
  clearSelection();
  showRows([]);
  document.body.innerHTML = "";
});

const at = (id: string) => document.getElementById(id);

describe("Select All, where focus is", () => {
  it("selects a terminal's buffer, not the field xterm types into", () => {
    document.body.innerHTML = `<div class="xterm" id="term"><textarea id="keys"></textarea></div>`;
    const terminal = { selectAll: vi.fn() };
    const forget = registerTerminal(at("term")!, terminal);
    expect(selectAllAt(at("keys"))).toBe("terminal");
    expect(terminal.selectAll).toHaveBeenCalledOnce();
    forget();
    expect(selectAllAt(at("keys"))).toBe("field");
  });

  it("selects a field's text, and an editable's contents", () => {
    document.body.innerHTML = `<input id="f" value="hello"><div contenteditable="true"><p id="p">one</p><p>two</p></div>`;
    const field = at("f") as HTMLInputElement;
    expect(selectAllAt(field)).toBe("field");
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5]);
    expect(selectAllAt(at("p"))).toBe("text");
    expect(window.getSelection()?.toString()).toBe("onetwo");
  });

  it("picks every row in sight in the sidebar, and selects nothing anywhere else", () => {
    document.body.innerHTML = `<nav data-selects-rows><button id="row"></button></nav><main><p id="text">words</p></main>`;
    showRows(["session:a", "session:b"]);
    expect(selectAllAt(at("row"))).toBe("rows");
    expect([...useSelection.getState().keys]).toEqual(["session:a", "session:b"]);
    clearSelection();
    window.getSelection()?.removeAllRanges();
    expect(selectAllAt(at("text"))).toBe("none");
    expect(selectAllAt(null)).toBe("none");
    expect(useSelection.getState().keys.size).toBe(0);
    expect(window.getSelection()?.toString()).toBe("");
  });
});
