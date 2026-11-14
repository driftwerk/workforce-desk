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
  /** `chrome.runtime.reload()`. */
  reload(): void;
}

/** What to do when Desk Helper expects `expected` and this build is
 *  `mine`. "reloading" is remembered before it's returned, so a reload that
 *  brings back the same old files never reloads again for `expected`. */
export const upToDate = async (expected: number, mine: number, r: Reloader): Promise<"current" | "reloading" | "store" | "tried"> => {
  if (expected <= mine) return "current";
  if ((await r.installType()) !== "development") return "store";
  const tried = await r.reloadedFor();
  if (tried !== null && tried >= expected) return "tried";
  await r.remember(expected);
  return "reloading";
};
