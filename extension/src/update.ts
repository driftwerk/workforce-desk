// Bringing an unpacked extension up to date. Chrome loads Desk's extension
// unpacked from extension/dist in development, and keeps running the code
// it loaded after a Desk install rebuilds that folder. Desk Helper says
// the revision it was built with on every connection; an unpacked build
// older than that reloads itself, once per revision, and Chrome starts it
// again from the new files. A Web Store install never does: Chrome updates
// it.

/** The parts of Chrome's API this uses, so tests can stand in. */
export interface Reloader {
  /** `chrome.management.getSelf().installType`: "development" for an
   *  unpacked build. */
  installType(): Promise<string>;
  /** The revision this extension last reloaded itself for, if any
   *  (`storage.local`: `storage.session` goes with a reload). */
  reloadedFor(): Promise<number | null>;
  remember(revision: number): Promise<void>;
  /** The revision of the build on disk now (`revision.json` in the
   *  extension's folder, which a build writes last); null when it can't be
   *  read, as mid-build. */
  onDisk(): Promise<number | null>;
  /** `chrome.runtime.reload()`. */
  reload(): void;
}

/** What to do when Desk Helper expects `expected` and this build is
 *  `mine`. Only files on disk that are at least `expected` are reloaded
 *  into: until then ("unbuilt": not rebuilt yet, or mid-build) the caller
 *  looks again later, and the one try isn't spent. "reloading" is
 *  remembered before it's returned, so a reload that somehow brings back
 *  old code never reloads again for `expected`. */
export const upToDate = async (expected: number, mine: number, r: Reloader): Promise<"current" | "reloading" | "store" | "unbuilt" | "tried"> => {
  if (expected <= mine) return "current";
  if ((await r.installType()) !== "development") return "store";
  const disk = await r.onDisk().catch(() => null);
  if (disk === null || disk < expected) return "unbuilt";
  const tried = await r.reloadedFor();
  if (tried !== null && tried >= expected) return "tried";
  await r.remember(expected);
  return "reloading";
};
