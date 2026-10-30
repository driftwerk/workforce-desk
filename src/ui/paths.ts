/** The last part of `path`, whichever separator it uses. */
export const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** `path` with the home folder it starts in shown as `~`: macOS's
 *  `/Users/you`, Linux's `/home/you`, or Windows' `C:\Users\you`. */
export const homeShort = (path: string): string => path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/, "~");
