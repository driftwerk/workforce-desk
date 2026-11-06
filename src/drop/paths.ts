// Paths typed into a terminal as Ghostty types a dropped file's: each
// shell-sensitive character escaped with a backslash, the paths joined by
// spaces, nothing after them (the person presses Enter). Claude Code reads
// such a path pasted into its prompt as the file, an image attached.
// (Ghostty: macos/Sources/Ghostty/Ghostty.Shell.swift, `escape`.)

/** The characters Ghostty escapes, in its order. */
const ESCAPED = "\\ ()[]{}<>\"'`!#$&;|*?\t";

/** `path` with each shell-sensitive character escaped. */
export const escapePath = (path: string): string => [...path].map((c) => (ESCAPED.includes(c) ? `\\${c}` : c)).join("");

/** Control characters (C0, DEL, C1), and Unicode's invisible formatting as
 *  desk-core's `machine::is_format` lists it: bidi embeddings, overrides
 *  and isolates, zero-width characters, the byte order mark, line and
 *  paragraph separators, tags and the characters that show as nothing. */
const UNTYPEABLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u0600-\u0605\u061c\u115f\u1160\u3164\uffa0\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{110bd}\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}]/u;

/** Whether `text` holds a control character, which typed into a terminal
 *  acts as a key (Return, Escape ending a bracketed paste) rather than
 *  being read however it is quoted, or invisible formatting, which shows
 *  it as other than it is (`evil\u202e` reading backwards). */
export const hasControl = (text: string): boolean => UNTYPEABLE.test(text);

/** What a terminal is given for `paths`; throws, saying which, for one that
 *  couldn't be typed safely. */
export const pathsLine = (paths: readonly string[]): string => {
  const bad = paths.find(hasControl);
  if (bad !== undefined)
    throw new Error(
      `“${bad.replace(new RegExp(UNTYPEABLE.source, "gu"), "?")}” has a control or invisible character in its name, which Desk won’t type into a terminal.`,
    );
  return paths.map(escapePath).join(" ");
};
