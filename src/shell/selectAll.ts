import { selectAll as selectRows } from "../groups/selection";
import { inApp, listen, subscribe } from "../platform";

// Select All (⌘A), which Desk's Edit menu sends here rather than leaving to
// the web view: what has focus decides what it selects.

/** The native menu's Select All, as the app's side names it. */
const SELECT_ALL_EVENT = "select-all";

/** Where Select All picks the sidebar's rows instead of any text. */
const SELECTS_ROWS = "data-selects-rows";

const terminals = new WeakMap<Element, { selectAll: () => void }>();

/** A terminal's element and the terminal, so Select All in it selects its
 *  buffer. Answers how to forget it. */
export const registerTerminal = (element: Element, terminal: { selectAll: () => void }): (() => void) => {
  terminals.set(element, terminal);
  return () => terminals.delete(element);
};

export type SelectedAll = "terminal" | "field" | "text" | "rows" | "none";

/** Selects everything where `target` is: a terminal's buffer, a field's
 *  text, an editable's contents, or the sidebar's rows; elsewhere nothing,
 *  so the page's own text is never swept up. Says which it did. */
export const selectAllAt = (target: Element | null): SelectedAll => {
  const terminal = target?.closest(".xterm");
  const term = terminal && terminals.get(terminal);
  if (term) {
    term.selectAll();
    return "terminal";
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.select();
    return "field";
  }
  const editable = target?.closest('[contenteditable]:not([contenteditable="false"])');
  if (editable) {
    const range = document.createRange();
    range.selectNodeContents(editable);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return "text";
  }
  if (target?.closest(`[${SELECTS_ROWS}]`)) {
    selectRows();
    return "rows";
  }
  return "none";
};

/** Follows the Edit menu's Select All in this window. */
export const followSelectAll = (): (() => void) =>
  inApp ? subscribe(listen(SELECT_ALL_EVENT, () => void selectAllAt(document.activeElement))) : () => {};
