// Emoticons typed in a composer, and the emoji each becomes once it's a
// whole word: `<3` then a space is ❤️, but `a:)b`, `C:\`, a URL, and
// anything in code are left as they are.

/** Each emoticon and its emoji, fully qualified (❤️ carries its U+FE0F, so
 *  it's drawn as an emoji and not as a black heart). */
export const EMOTICONS: Readonly<Record<string, string>> = {
  "<3": "\u2764\uFE0F",
  "</3": "\u{1F494}",
  ":)": "\u{1F642}",
  ":-)": "\u{1F642}",
  ":D": "\u{1F604}",
  ":-D": "\u{1F604}",
  ";)": "\u{1F609}",
  ";-)": "\u{1F609}",
  ":(": "\u{1F641}",
  ":-(": "\u{1F641}",
  ":P": "\u{1F61B}",
  ":-P": "\u{1F61B}",
  ":p": "\u{1F61B}",
  ":-p": "\u{1F61B}",
  ":O": "\u{1F62E}",
  ":-O": "\u{1F62E}",
  ":o": "\u{1F62E}",
  ":-o": "\u{1F62E}",
  ":'(": "\u{1F622}",
  xD: "\u{1F606}",
  XD: "\u{1F606}",
  "^_^": "\u{1F60A}",
  "8)": "\u{1F60E}",
  "8-)": "\u{1F60E}",
  ":*": "\u{1F618}",
  ":-*": "\u{1F618}",
  "o/": "\u{1F44B}",
  "(y)": "\u{1F44D}",
  "(Y)": "\u{1F44D}",
};

/** The keys that end a word and so turn the emoticon before them into its
 *  emoji: a space, a new line (Shift+Enter; Enter itself sends, and what's
 *  sent is settled first), and the punctuation that ends a phrase. The
 *  characters emoticons are made of (`:`, `;`, `)`, `(`) aren't among them,
 *  so `:))` or `:-((` stay as typed. */
export const ENDS_WORD: ReadonlySet<string> = new Set([" ", "Enter", ".", ",", "!", "?"]);

/** What a key that ends a word puts in the text. */
export const typedBy = (key: string): string => (key === "Enter" ? "\n" : key);

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Whether `pos` in `text` is in code: inside a fenced block (or on its
 *  opening line), or between backticks on its own line. */
export const inCode = (text: string, pos: number): boolean => {
  const lines = text.slice(0, pos).split("\n");
  const current = lines.pop() ?? "";
  let fenced = false;
  for (const line of lines) if (FENCE.test(line)) fenced = !fenced;
  if (fenced || FENCE.test(current)) return true;
  return (current.match(/`/g)?.length ?? 0) % 2 === 1;
};

export interface Conversion {
  /** Where the emoticon starts and ends. */
  start: number;
  end: number;
  /** As typed. */
  typed: string;
  emoji: string;
}

/** The emoticon that ends at `caret`, if it's a whole word there: at the
 *  start or after a space or new line, and not in code. A URL is a word of
 *  its own, so nothing inside one is. */
export const emoticonBefore = (text: string, caret: number): Conversion | null => {
  const word = /(?:^|\s)(\S+)$/.exec(text.slice(0, caret))?.[1];
  // Its own keys only: "constructor" isn't an emoticon.
  const emoji = word !== undefined && Object.hasOwn(EMOTICONS, word) ? EMOTICONS[word] : undefined;
  if (!word || !emoji) return null;
  const start = caret - word.length;
  return inCode(text, start) ? null : { start, end: caret, typed: word, emoji };
};
