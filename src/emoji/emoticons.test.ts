import { describe, expect, it } from "vitest";
import { EMOTICONS, emoticonBefore, ENDS_WORD, inCode } from "./emoticons";
import { shortcodeAt, shortcodeBefore, suggest } from "./shortcodes";
import { drawable, type EmojiEntry } from "./data";

const at = (text: string) => emoticonBefore(text, text.length);
const codePoints = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16).toUpperCase());

describe("emoticons", () => {
  it("each in the table is its emoji, fully qualified", () => {
    const table: [string, string][] = [
      ["<3", "❤️"],
      ["</3", "💔"],
      [":)", "🙂"],
      [":-)", "🙂"],
      [":D", "😄"],
      [";)", "😉"],
      [":(", "🙁"],
      [":P", "😛"],
      [":O", "😮"],
      [":'(", "😢"],
      ["xD", "😆"],
      ["^_^", "😊"],
      ["8)", "😎"],
      [":*", "😘"],
      ["o/", "👋"],
      ["(y)", "👍"],
    ];
    for (const [typed, emoji] of table) expect(at(`hi ${typed}`)?.emoji, typed).toBe(emoji);
    // ❤ alone is a black heart in most fonts: the heart carries U+FE0F.
    expect(codePoints(EMOTICONS["<3"]!)).toEqual(["2764", "FE0F"]);
  });

  it("is a whole word: at the start or after a space or new line", () => {
    expect(at("<3")).toEqual({ start: 0, end: 2, typed: "<3", emoji: "❤️" });
    expect(at("great\n:)")).toMatchObject({ start: 6, typed: ":)" });
    expect(at("tab\t:D")).toMatchObject({ typed: ":D" });
    // In the middle of the text, before the caret.
    expect(emoticonBefore("a <3 b", 4)).toMatchObject({ start: 2, end: 4 });
  });

  it("is nothing inside another word, a path or a URL", () => {
    for (const text of ["a:)", "C:\\", "C:", "x<3", "https://example.com/:)", "see http://a.b/<3", "foo(y)", "lol:P", "0xD", "a8)", "and/o/", "^_^^"]) {
      expect(at(text), text).toBeNull();
    }
    // `a:)b` once a space is typed after the b.
    expect(emoticonBefore("a:)b ", 4)).toBeNull();
  });

  it("only what's in the table", () => {
    for (const text of [":/", ":))", ":-((", "<33", "constructor", "__proto__", "toString"]) expect(at(`x ${text}`), text).toBeNull();
  });

  it("is nothing in code", () => {
    expect(at("run `x :)")).toBeNull();
    expect(at("`a` then :)")).not.toBeNull();
    expect(at("```\nconst a = 1 :)")).toBeNull();
    expect(at("```ts :)")).toBeNull();
    expect(at("```\ncode\n```\nafter :)")).not.toBeNull();
    expect(at("~~~\n<3")).toBeNull();
    expect(inCode("a `b` c", 7)).toBe(false);
  });

  it("ends on a space, Enter and closing punctuation, not on the characters emoticons are made of", () => {
    for (const k of [" ", "Enter", ".", ",", "!", "?"]) expect(ENDS_WORD.has(k), k).toBe(true);
    for (const k of [":", ";", ")", "(", "-", "a", "Tab"]) expect(ENDS_WORD.has(k), k).toBe(false);
  });
});

const entry = (emoji: string, shortcodes: string[], order: number): EmojiEntry => ({
  emoji,
  label: shortcodes[0]!,
  group: 0,
  order,
  version: 1,
  tags: [],
  shortcodes,
});
const SET = (() => {
  const entries = [
    entry("😍", ["heart_eyes"], 8),
    entry("❤️", ["heart"], 155),
    entry("💓", ["heartbeat"], 160),
    entry("🙉", ["hear_no_evil"], 120),
    entry("😄", ["smile"], 2),
    entry("👍", ["+1", "thumbsup"], 300),
  ];
  return { entries, byShortcode: new Map(entries.flatMap((e) => e.shortcodes.map((c) => [c, e] as const))) };
})();

describe(":shortcodes", () => {
  it("open after a colon and two letters, at the start or after a space", () => {
    expect(shortcodeAt(":he", 3)).toEqual({ start: 0, query: "he" });
    expect(shortcodeAt("so :HEA", 7)).toEqual({ start: 3, query: "hea" });
    expect(shortcodeAt("(:sm", 4)).toEqual({ start: 1, query: "sm" });
    for (const text of [":h", "Note:this", "https://x", "at 10:30", ":)", ":D", "a:hea", "`:hea", "```\n:hea"]) {
      expect(shortcodeAt(text, text.length), text).toBeNull();
    }
  });

  it("offer the closest names first", () => {
    expect(suggest("hea", SET).map((s) => s.name)).toEqual(["heart", "heartbeat", "heart_eyes", "hear_no_evil"]);
    // A word of a name counts after the names that start with it.
    expect(suggest("eyes", SET).map((s) => s.name)).toEqual(["heart_eyes"]);
    expect(suggest("thu", SET)[0]!.entry.emoji).toBe("👍");
  });

  it("a finished one is its emoji, when there's one by that name", () => {
    expect(shortcodeBefore("so :smile", 9, SET)).toMatchObject({ start: 3, end: 9, typed: ":smile:" });
    expect(shortcodeBefore(":+1", 3, SET)?.entry.emoji).toBe("👍");
    expect(shortcodeBefore(":nope", 5, SET)).toBeNull();
    expect(shortcodeBefore("12:30:smile", 11, SET)).toBeNull();
    expect(shortcodeBefore("`:smile", 7, SET)).toBeNull();
  });
});

describe("which emoji this computer draws", () => {
  const entries = [
    { emoji: "🙂", version: 1 },
    { emoji: "🥲", version: 13 },
    { emoji: "🫩", version: 16 },
  ];
  /** A canvas that draws in colour (an emoji keeps its own) up to `newest`. */
  const canvas = (newest: string | null, { throws = false } = {}) => {
    let fill = "";
    let text = "";
    const rank = (e: string) => entries.findIndex((x) => x.emoji === e);
    return {
      measureText: (t: string) => ({ width: t.length > 2 && !t.startsWith("\u{1F1EA}") ? 40 : 16 }),
      clearRect: () => {},
      set fillStyle(v: string) {
        fill = v;
      },
      fillText: (t: string) => void (text = t),
      getImageData: () => {
        if (throws) throw new Error("tainted");
        const colour = newest !== null && rank(text) >= 0 && rank(text) <= rank(newest);
        return { data: Uint8ClampedArray.from(colour ? [200, 100, 50, 255] : fill === "#00f" ? [0, 0, 255, 255] : [255, 0, 0, 255]) };
      },
    } as unknown as CanvasRenderingContext2D;
  };

  it("the newest version it draws in colour", () => {
    expect(drawable(entries, canvas("🥲")).version).toBe(13);
    expect(drawable(entries, canvas("🫩")).version).toBe(16);
  });

  it("everything, where it can't tell: no canvas, one it can't read, or no colour emoji at all", () => {
    expect(drawable(entries, null)).toEqual({ version: Infinity, flags: true });
    expect(drawable(entries, canvas(null))).toEqual({ version: Infinity, flags: true });
    expect(drawable(entries, canvas("🫩", { throws: true }))).toEqual({ version: Infinity, flags: true });
  });
});
