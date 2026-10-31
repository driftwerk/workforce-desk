import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../settings/store";
import { loadEmoji } from "./data";
import { EmojiButton } from "./EmojiButton";
import { EMOJI_KEY } from "./prefs";
import { useEmojiInput } from "./useEmojiInput";
import { deskState } from "../restore/boot";

// jsdom draws nothing, so every emoji counts as drawable; and lays nothing
// out, which the picker measures.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollTo = () => {};

const sent: string[] = [];

/** A composer as Desk's are: the box, the hook, and the emoji button. */
function Box() {
  const [value, setValue] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const emoji = useEmojiInput({ field, value, setValue });
  return (
    <form className="composer">
      {emoji.menu}
      <textarea
        ref={field}
        aria-label="Message"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          emoji.onChange(e);
        }}
        onSelect={emoji.onSelect}
        onFocus={emoji.onFocus}
        onKeyDown={(e) => {
          if (emoji.onKeyDown(e)) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sent.push(emoji.settle(value));
            setValue("");
          }
        }}
      />
      <EmojiButton onPick={emoji.insert} />
    </form>
  );
}

/** The picker's emoji (not the one it measures rows with). */
const CELL = '[role="row"] [frimousse-emoji]';

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

/** A key as the browser takes it: what it types goes in at the caret,
 *  unless the page took the key. */
const press = (key: string, init: { shiftKey?: boolean } = {}) => {
  const el = box();
  const typed = fireEvent.keyDown(el, { key, ...init });
  if (!typed) return;
  const s = el.selectionStart;
  const e = el.selectionEnd;
  const put = key === "Enter" ? (init.shiftKey ? "\n" : null) : key === "Backspace" ? "" : key.length === 1 ? key : null;
  if (put === null) return;
  const from = key === "Backspace" && s === e ? Math.max(0, s - [...el.value.slice(0, s)].slice(-1)[0]!.length) : s;
  const value = el.value.slice(0, from) + put + el.value.slice(e);
  fireEvent.change(el, { target: { value, selectionStart: from + put.length, selectionEnd: from + put.length } });
};
const type = (text: string) => {
  for (const ch of text) press(ch === "\n" ? "Enter" : ch, ch === "\n" ? { shiftKey: true } : {});
};

beforeAll(async () => {
  // Loaded once up front (as the first focus of a composer would), with the
  // picker's chunk, so no test waits on either.
  await Promise.all([loadEmoji(), import("./EmojiPicker")]);
}, 30_000);
beforeEach(() => {
  sent.length = 0;
  useSettings.setState({ emoticons: true });
  deskState.remove(EMOJI_KEY);
});
afterEach(cleanup);

describe("emoticons as you type", () => {
  it("become their emoji once a space, punctuation or Shift+Enter follows", () => {
    render(<Box />);
    type("love you <3 ");
    expect(box().value).toBe("love you ❤️ ");
    type("see you :).");
    expect(box().value).toBe("love you ❤️ see you 🙂.");
    type(" (y)\nok");
    expect(box().value).toBe("love you ❤️ see you 🙂. 👍\nok");
    expect(box().selectionStart).toBe(box().value.length);
  });

  it("Enter sends the last one as its emoji", () => {
    render(<Box />);
    type("thanks xD");
    press("Enter");
    expect(sent).toEqual(["thanks 😆"]);
  });

  it("are left alone where they aren't a word of their own, or are code", () => {
    render(<Box />);
    type("a:)b C:\\ https://x.dev/:) `c :) ` ");
    expect(box().value).toBe("a:)b C:\\ https://x.dev/:) `c :) ` ");
    cleanup();
    render(<Box />);
    type("```\nx :) ");
    expect(box().value).toBe("```\nx :) ");
  });

  it("keep the caret where it was, in the middle of the text", () => {
    render(<Box />);
    type("hi  there");
    act(() => box().setSelectionRange(3, 3));
    fireEvent.select(box());
    type("<3 ");
    expect(box().value).toBe("hi ❤️  there");
    expect(box().selectionStart).toBe(3 + "❤️ ".length);
  });

  it("Backspace straight after puts back what was typed, which then stays", () => {
    render(<Box />);
    type("I <3 ");
    expect(box().value).toBe("I ❤️ ");
    // A modifier pressed on its own in between changes nothing.
    press("Shift");
    press("Backspace");
    expect(box().value).toBe("I <3 ");
    expect(box().selectionStart).toBe(5);
    // Typed on, it isn't changed again, nor when it's sent.
    press("Backspace");
    type(".");
    expect(box().value).toBe("I <3.");
    press("Backspace");
    press("Enter");
    expect(sent).toEqual(["I <3"]);
    // Gone from the text, it's forgotten: typed again, it converts.
    type("I <3");
    fireEvent.change(box(), { target: { value: "", selectionStart: 0, selectionEnd: 0 } });
    type("I <3 ");
    expect(box().value).toBe("I ❤️ ");
  });

  it("Backspace after anything else is just Backspace", () => {
    render(<Box />);
    type(":) x");
    press("Backspace");
    expect(box().value).toBe("🙂 ");
  });

  it("go through the browser's own editing where it has it, so undo takes them back", () => {
    const calls: [number, number, string][] = [];
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    document.execCommand = vi.fn((_cmd: string, _ui?: boolean, text?: string) => {
      const el = document.activeElement as HTMLTextAreaElement;
      const [s, e] = [el.selectionStart, el.selectionEnd];
      calls.push([s, e, text!]);
      setValue.call(el, el.value.slice(0, s) + text + el.value.slice(e));
      el.setSelectionRange(s + text!.length, s + text!.length);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    });
    try {
      render(<Box />);
      type("ok :D ");
      expect(document.execCommand).toHaveBeenCalledWith("insertText", false, "😄 ");
      expect(calls).toEqual([[3, 5, "😄 "]]);
      expect(box().value).toBe("ok 😄 ");
    } finally {
      delete (document as { execCommand?: unknown }).execCommand;
    }
  });

  it("stay as typed with the setting off", () => {
    useSettings.setState({ emoticons: false });
    render(<Box />);
    type("<3 :) ");
    press("Enter");
    type("bye o/");
    press("Enter");
    expect(sent).toEqual(["<3 :) ", "bye o/"]);
  });
});

describe(":shortcodes", () => {
  it("offer emoji by name as you type, and Enter puts the chosen one in", () => {
    render(<Box />);
    type("so :hea");
    const options = screen.getAllByRole("option");
    expect(options[0]!.textContent).toBe("❤️:heart:red heart");
    expect(options.some((o) => o.textContent?.includes(":heart_eyes:"))).toBe(true);
    expect(box().getAttribute("aria-expanded")).toBeNull();
    press("ArrowDown");
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    press("ArrowUp");
    press("Enter");
    expect(box().value).toBe("so ❤️");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("Tab chooses too, and Escape closes the list until you type on", () => {
    render(<Box />);
    type(":tad");
    press("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("a");
    expect(screen.getByRole("listbox")).toBeTruthy();
    press("Tab");
    expect(box().value).toBe("🎉");
  });

  it("a finished one is its emoji, and Backspace takes it back", () => {
    render(<Box />);
    type("nice :smile:");
    expect(box().value).toBe("nice 😄");
    press("Backspace");
    expect(box().value).toBe("nice :smile:");
    type(" :nope: ok");
    expect(box().value).toBe("nice :smile: :nope: ok");
  });

  it("aren't looked for inside words, times or links", () => {
    render(<Box />);
    type("at 10:30am Note:this https://x");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("the emoji button", () => {
  it("opens a picker whose emoji goes in at the caret, and is kept as recent", async () => {
    render(<Box />);
    type("ab");
    act(() => box().setSelectionRange(1, 1));
    fireEvent.click(screen.getByRole("button", { name: "Add an emoji" }));
    await screen.findByRole("searchbox", { name: "Search emoji" });
    const dialog = screen.getByRole("dialog", { name: "Emoji" });
    const first = await waitFor(() => {
      const cells = dialog.querySelectorAll<HTMLButtonElement>(CELL);
      expect(cells.length).toBeGreaterThan(0);
      return cells[0]!;
    });
    const picked = first.textContent!;
    fireEvent.click(first);
    expect(box().value).toBe(`a${picked}b`);
    expect(box().selectionStart).toBe(1 + picked.length);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Opened again, it's first among the recent ones.
    fireEvent.click(screen.getByRole("button", { name: "Add an emoji" }));
    const recent = await screen.findByRole("group", { name: "Recently used" });
    expect(recent.querySelector("button")?.textContent).toBe(picked);
  });

  it("is used from the keyboard: search, arrows, Enter; Escape closes it", async () => {
    render(<Box />);
    const button = screen.getByRole("button", { name: "Add an emoji" });
    fireEvent.click(button);
    const search = await screen.findByRole("searchbox", { name: "Search emoji" });
    fireEvent.change(search, { target: { value: "tada" } });
    await waitFor(() => expect(document.querySelector(CELL)?.textContent).toBe("🎉"));
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(box().value).toBe("🎉"));
    fireEvent.click(button);
    const again = await screen.findByRole("searchbox", { name: "Search emoji" });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("keeps the skin tone you pick", async () => {
    render(<Box />);
    fireEvent.click(screen.getByRole("button", { name: "Add an emoji" }));
    const tones = await screen.findByRole("radiogroup", { name: "Skin tone" });
    const dark = await waitFor(() => {
      const b = [...tones.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "Dark skin tone");
      expect(b).toBeTruthy();
      return b!;
    });
    fireEvent.click(dark);
    expect(dark.getAttribute("aria-checked")).toBe("true");
    expect(deskState.get(EMOJI_KEY)).toMatchObject({ tone: "dark" });
    // A :shortcode in that tone too.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    type(":wav");
    expect(screen.getAllByRole("option")[0]!.textContent).toContain("👋🏿");
  });
});
