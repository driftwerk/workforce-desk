// Emoji in a composer's box, for every composer alike: emoticons become
// emoji as you type (unless Settings → Chat says not to), `:shortcode`
// offers a list and a finished `:smile:` is its emoji, Backspace straight
// after any of these puts back what was typed, and the picker inserts at the
// caret.
//
// Changes go through the browser's own editing (insertText), so ⌘Z/Ctrl+Z
// undoes them like typing; where that isn't there, the text is set and the
// caret put back.

import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import { useSettings } from "../settings/store";
import { inTone, useEmojiSet } from "./data";
import { emoticonBefore, ENDS_WORD, typedBy } from "./emoticons";
import { used, useEmojiPrefs } from "./prefs";
import { shortcodeAt, shortcodeBefore, suggest, type Suggestion } from "./shortcodes";

/** A change just made, which Backspace takes back while nothing else has
 *  happened since. */
interface Made {
  from: number;
  /** Where the caret was left. */
  to: number;
  /** What was typed, the key that changed it included. */
  typed: string;
  /** The text it left. */
  value: string;
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);

export interface EmojiInput {
  /** Call first from the box's onKeyDown: true when it took the key. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Call from the box's onChange. */
  onChange: (e: SyntheticEvent<HTMLTextAreaElement>) => void;
  onSelect: (e: SyntheticEvent<HTMLTextAreaElement>) => void;
  onFocus: () => void;
  /** What's sent, with an emoticon it ends with as its emoji. */
  settle: (text: string) => string;
  /** Puts `emoji` where the caret is (over what's selected). */
  insert: (emoji: string) => void;
  /** The `:shortcode` list, while it's open. */
  open: boolean;
  listId: string;
  activeId: string | undefined;
  menu: ReactNode;
}

export function useEmojiInput({
  field,
  value,
  setValue,
}: {
  field: RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (text: string) => void;
}): EmojiInput {
  const emoticons = useSettings((s) => s.emoticons);
  const { tone } = useEmojiPrefs();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Escape closes the list until you type on.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const listId = useId();
  const made = useRef<Made | null>(null);
  // What Backspace put back, which stays as typed: so `<3` can be sent.
  const kept = useRef<{ start: number; typed: string } | null>(null);
  // Where the caret goes once text set (not edited) has rendered.
  const caretAfter = useRef<number | null>(null);

  const typing = shortcodeAt(value, caret);
  // Loaded from the box's first focus, so the list is there by `:sm`.
  const set = useEmojiSet(focused || !!typing);
  const options: Suggestion[] = typing && dismissed !== typing.start && set ? suggest(typing.query, set) : [];
  const open = options.length > 0;
  const current = Math.min(active, options.length - 1);

  useLayoutEffect(() => {
    const at = caretAfter.current;
    const el = field.current;
    if (at === null || !el || el.value !== value) return;
    caretAfter.current = null;
    el.setSelectionRange(at, at);
  }, [value, field]);

  /** `text` in place of `from`–`to`; the text it leaves. */
  const replace = (from: number, to: number, text: string): string => {
    const el = field.current;
    const base = el?.value ?? value;
    const next = base.slice(0, from) + text + base.slice(to);
    const at = from + text.length;
    if (el) {
      el.focus();
      el.setSelectionRange(from, to);
      let edited = false;
      try {
        edited = document.execCommand("insertText", false, text);
      } catch {
        edited = false;
      }
      if (edited && el.value === next) {
        setCaret(at);
        return next;
      }
    }
    caretAfter.current = at;
    setValue(next);
    setCaret(at);
    return next;
  };

  const isKept = (start: number, typed: string) => kept.current?.start === start && kept.current.typed === typed;

  const pick = (s: Suggestion) => {
    if (!typing) return;
    const el = field.current;
    const text = el?.value ?? value;
    // The rest of the name, if the caret was inside it, and a closing colon.
    const rest = /^[a-z0-9_+-]*:?/i.exec(text.slice(caret))?.[0] ?? "";
    const emoji = inTone(s.entry, tone);
    replace(typing.start, caret + rest.length, emoji);
    used(emoji);
    setActive(0);
    made.current = null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.nativeEvent.isComposing) return false;
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((current + step + options.length) % options.length);
        return true;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pick(options[current]!);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(typing!.start);
        return true;
      }
    }
    const el = e.currentTarget;
    const at = el.selectionStart;
    const collapsed = at === el.selectionEnd;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    // A modifier on its own (Shift held for the next key) changes nothing.
    if (MODIFIERS.has(e.key)) return false;
    const last = made.current;
    made.current = null;
    if (e.key === "Backspace" && collapsed && plain && last && last.to === at && last.value === el.value) {
      e.preventDefault();
      replace(last.from, last.to, last.typed);
      kept.current = { start: last.from, typed: last.typed.replace(/[\s.,!?]$/, "") };
      return true;
    }
    if (!collapsed || !plain) return false;
    const change = (from: number, emoji: string, typed: string, key: string) => {
      e.preventDefault();
      const text = emoji + key;
      made.current = { from, to: from + text.length, typed: typed + key, value: replace(from, at, text) };
    };
    if (e.key === ":" && set) {
      const found = shortcodeBefore(el.value, at, set);
      if (found && !isKept(found.start, found.typed)) {
        const emoji = inTone(found.entry, tone);
        // The colon typed closes the code, and goes with it.
        change(found.start, emoji, found.typed, "");
        used(emoji);
        return true;
      }
    }
    if (emoticons && ENDS_WORD.has(e.key) && (e.key !== "Enter" || e.shiftKey)) {
      const found = emoticonBefore(el.value, at);
      if (found && !isKept(found.start, found.typed)) {
        change(found.start, found.emoji, found.typed, typedBy(e.key));
        return true;
      }
    }
    return false;
  };

  const settle = (text: string): string => {
    made.current = null;
    const k = kept.current;
    kept.current = null;
    if (!emoticons) return text;
    const found = emoticonBefore(text, text.trimEnd().length);
    // An emoticon Backspace put back is sent as typed.
    if (!found || (k?.start === found.start && k.typed === found.typed)) return text;
    return text.slice(0, found.start) + found.emoji + text.slice(found.end);
  };

  const insert = (emoji: string) => {
    const el = field.current;
    const from = el?.selectionStart ?? value.length;
    const to = el?.selectionEnd ?? from;
    replace(from, to, emoji);
    made.current = null;
  };

  const menu = open ? (
    <ul className="mention-menu emoji-menu" role="listbox" id={listId} aria-label="Emoji">
      {options.map((o, i) => (
        <li
          key={o.entry.emoji}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={i === current}
          className="mention-option"
          onMouseDown={(ev) => {
            ev.preventDefault();
            pick(o);
          }}
          onMouseEnter={() => setActive(i)}
        >
          <span className="emoji-glyph" aria-hidden="true">
            {inTone(o.entry, tone)}
          </span>
          <b>:{o.name}:</b>
          <span className="faint small">{o.entry.label}</span>
        </li>
      ))}
    </ul>
  ) : null;

  return {
    onKeyDown,
    onChange: (e) => {
      // What Backspace put back stays as typed only while it's there.
      const k = kept.current;
      if (k && e.currentTarget.value.slice(k.start, k.start + k.typed.length) !== k.typed) kept.current = null;
      setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
      setActive(0);
      setDismissed(null);
    },
    onSelect: (e) => setCaret(e.currentTarget.selectionStart ?? 0),
    onFocus: () => setFocused(true),
    settle,
    insert,
    open,
    listId,
    activeId: open ? `${listId}-${current}` : undefined,
    menu,
  };
}
