// Paths typed into a terminal as Ghostty types a dropped file's: each
// shell-sensitive character escaped with a backslash, the paths joined by
// spaces, nothing after them (the person presses Enter). Claude Code reads
// such a path pasted into its prompt as the file, an image attached.
// (Ghostty: macos/Sources/Ghostty/Ghostty.Shell.swift, `escape`.)

/** The characters Ghostty escapes, in its order. */
const ESCAPED = "\\ ()[]{}<>\"'`!#$&;|*?\t";

/** `path` with each shell-sensitive character escaped. */
export const escapePath = (path: string): string => [...path].map((c) => (ESCAPED.includes(c) ? `\\${c}` : c)).join("");

/** Whether `text` holds a control character (C0, DEL, C1): one typed into a
 *  terminal acts as a key (Return, Escape ending a bracketed paste) rather
 *  than being read, however it is quoted. */
export const hasControl = (text: string): boolean => /[\u0000-\u001f\u007f-\u009f]/.test(text);

/** What a terminal is given for `paths`; throws, saying which, for one that
 *  couldn't be typed safely. */
export const pathsLine = (paths: readonly string[]): string => {
  const bad = paths.find(hasControl);
  if (bad !== undefined)
    throw new Error(`“${bad.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")}” has a control character in its name, which Desk won’t type into a terminal.`);
  return paths.map(escapePath).join(" ");
};
