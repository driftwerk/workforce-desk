// Each call the hub makes, done in Desk's own tab. What a page may be is
// checked here too (the web, or a blank page), though the hub decides it
// first: the extension never opens or runs in Chrome's own pages, files,
// scripts or the Web Store.

import type { DeskTabs } from "./desk";
import { asksPassword, clickOn, fillField, focused, hrefNow, onKeyPage, present, pressKey, readKey, readPage, selectOption, setFiles, shownOf, typeText } from "./page";
import { MAX_HTML, MAX_KEY, MAX_TEXT, MAX_UPLOAD_BYTES, type Command } from "./protocol";

/** The parts of Chrome's API calls use, so tests can stand in. */
export interface Exec {
  /** Runs `func(...args)` in `tabId`'s page, in the isolated world. */
  run<A extends unknown[], R>(tabId: number, func: (...args: A) => R, args: A): Promise<R>;
  /** Loads `url` in `tabId` and waits for it (or `timeoutMs`). */
  navigate(tabId: number, url: string, timeoutMs: number): Promise<void>;
  where(tabId: number): Promise<{ url: string; title: string }>;
  /** A PNG of `windowId`'s active tab, as a data URL, if that tab is
   *  `tabId` in the moment it is taken; null when it isn't. */
  capture(windowId: number, tabId: number): Promise<string | null>;
  activate(tabId: number): Promise<void>;
  front(windowId: number, tabId: number): Promise<void>;
  /** Makes `tabId` the active tab of `windowId` and that window the focused
   *  one, restoring it only if minimised: the person's window keeps its
   *  size. */
  raise(windowId: number, tabId: number): Promise<void>;
  /** Whether `tabId` is the active tab of `windowId`, and that window is
   *  focused and not minimised, as Chrome says now. */
  inFront(windowId: number, tabId: number): Promise<{ active: boolean; focused: boolean }>;
  sleep(ms: number): Promise<void>;
}

/** Whether the extension may show or work in `url`: the web and a blank
 *  page only. Never `chrome://`, the Web Store, files, scripts or data. */
export const workable = (url: string): boolean => {
  if (url === "about:blank") return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return u.hostname !== "chromewebstore.google.com" && !(u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore"));
};

const NAVIGATION_MS = 30_000;

export class Fail extends Error {}

/** One picture at a time, across every session: making Desk's tab the
 *  active one, reading it and picturing it is one step no other picture
 *  comes between. */
let pictures: Promise<unknown> = Promise.resolve();
const onePicture = <T>(f: () => Promise<T>): Promise<T> => {
  const next = pictures.then(f, f);
  pictures = next.catch(() => undefined);
  return next;
};

/** What a page step on a selector Chrome can't parse is told. */
const badSelector = (selector: string) =>
  `Chrome can't use \`${selector}\` as a selector, so nothing was done. It takes CSS only (\`:has-text()\` and \`text=\` are Playwright's): read the page's HTML with browser.get_content and pick the element by its id, name, aria-label or class.`;

/** A page step that answered nothing: Chrome didn't run it to the end. */
const NOT_RUN = "Chrome didn't run that on the page, so nothing was done.";

const typed = (done: "ok" | "missing" | "moved", missing: string) => {
  if (done === "moved") throw new Fail("The page moved since this was decided, so nothing was typed.");
  if (done === "missing") throw new Fail(missing);
  if (done !== "ok") throw new Fail("Chrome didn't type that, so nothing was typed.");
  return true;
};

/** Does `c`, answering what it returns. */
export async function perform(c: Command, tabs: DeskTabs, exec: Exec): Promise<unknown> {
  if (c.cmd === "stop") return { closed: await tabs.stop() };
  if (c.cmd === "hand_over") return handOver(c.session, tabs, exec);
  if (c.cmd === "close") return { closed: await tabs.close(c.session) };
  if (c.cmd === "open") {
    const tab = await tabs.tabFor(c.session);
    return exec.where(tab);
  }
  // Every other call works in the session's tab, which it opens when needed.
  const tab = await tabs.tabFor(c.session);
  const run = async <A extends unknown[], R>(func: (...args: A) => R, args: A): Promise<Exclude<R, "bad_selector">> => {
    const r = await exec.run(tab, func, args);
    if (r === "bad_selector") throw new Fail(badSelector("selector" in c ? (c.selector ?? "") : ""));
    if (r === undefined) throw new Fail(NOT_RUN);
    return r as Exclude<R, "bad_selector">;
  };
  const here = async () => {
    const at = await exec.where(tab);
    if (!workable(at.url)) throw new Fail("Desk's tab is on a page Desk doesn't work in.");
    return at;
  };
  switch (c.cmd) {
    case "navigate": {
      if (!workable(c.url)) throw new Fail("Desk opens web pages and a blank page only.");
      await exec.navigate(tab, c.url, NAVIGATION_MS);
      return exec.where(tab);
    }
    case "where": {
      const at = await exec.where(tab);
      if (!c.password) return at;
      // Whether the page asks for a password, where Desk may look.
      const password = workable(at.url) ? await run(asksPassword, []).catch(() => false) : false;
      return { ...at, password: password === true };
    }
    case "read": {
      await here();
      return run(readPage, [c.what, MAX_TEXT, MAX_HTML]);
    }
    case "shown":
      await here();
      return run(shownOf, [c.selector, c.form]);
    case "click": {
      await here();
      const done = await run(clickOn, [c.selector]);
      if (done === "missing") throw new Fail(`Nothing on the page matches \`${c.selector}\`.`);
      if (done === "hidden") throw new Fail(`\`${c.selector}\` isn't showing, so it wasn't clicked.`);
      if (done === "covered") throw new Fail(`Something else lies over \`${c.selector}\`, so it wasn't clicked.`);
      if (done !== "ok") throw new Fail(NOT_RUN);
      return true;
    }
    case "fill": {
      await here();
      return typed(await run(fillField, [c.selector, c.value, c.origin ?? null]), `Nothing on the page matches \`${c.selector}\`.`);
    }
    case "type": {
      await here();
      if (c.selector && !(await run(focused, [c.selector]))) {
        // Typing goes only where the field has the focus.
        typed(await run(typeText, [c.selector, "", c.origin ?? null]), `Nothing on the page matches \`${c.selector}\`.`);
        if (!(await run(focused, [c.selector]))) throw new Fail(`\`${c.selector}\` didn't take the focus, so nothing was typed.`);
      }
      return typed(await run(typeText, [c.selector, c.text, c.origin ?? null]), "There's nothing to type into.");
    }
    case "press": {
      await here();
      if (!(await run(pressKey, [c.selector, c.key]))) throw new Fail("There's nothing to press the key on.");
      return true;
    }
    case "select": {
      await here();
      if (!(await run(selectOption, [c.selector, c.value]))) throw new Fail(`\`${c.selector}\` has no option \`${c.value}\`.`);
      return true;
    }
    case "wait": {
      const until = Date.now() + Math.min(Math.max(c.timeout_ms, 0), 120_000);
      let pause = 100;
      for (;;) {
        const at = await exec.where(tab);
        // A page between loads can't be asked yet; a selector Chrome can't use never will be.
        const there = workable(at.url) ? await exec.run(tab, present, [c.selector]).catch(() => false) : false;
        if (there === "bad_selector") throw new Fail(badSelector(c.selector));
        if (there === true) return true;
        if (Date.now() >= until) throw new Fail(`\`${c.selector}\` didn't appear in time.`);
        await exec.sleep(pause);
        pause = Math.min(pause * 2, 1000);
      }
    }
    case "upload": {
      await here();
      const bytes = c.files.reduce((n, f) => n + Math.floor((f.base64.length * 3) / 4), 0);
      if (bytes > MAX_UPLOAD_BYTES) throw new Fail("Those files are too big for Desk to hand to Chrome in one go.");
      if (!(await run(setFiles, [c.selector, c.files]))) throw new Fail(`\`${c.selector}\` isn't a file field.`);
      return true;
    }
    case "capture":
      return onePicture(async () => {
        await here();
        // A minimised window is never restored behind the person's back.
        if (await tabs.minimised()) return { skipped: "minimised" };
        const windowId = await tabs.windowId();
        if (windowId === null) throw new Fail("Desk's window isn't open.");
        await exec.activate(tab);
        // A key page is never pictured: its address read again right now,
        // with what it shows, for the hub to check the tab it pictured.
        if (c.refuse?.length && (await run(onKeyPage, [c.refuse]))) return { skipped: "key page" };
        const seen = await run(readPage, ["all", MAX_TEXT, 0]);
        const data = await exec.capture(windowId, tab);
        if (data === null) return { skipped: "not_front" };
        // The page moved while it was pictured: the picture isn't of it.
        if ((await run(hrefNow, [])) !== seen.url) return { skipped: "moved" };
        return { png_base64: data.replace(/^data:image\/png;base64,/, ""), url: seen.url, text: seen.text ?? "" };
      });
    case "capture_key": {
      await here();
      const read = await run(readKey, [c.selector ?? null, c.origin, c.paths, MAX_KEY, c.shape ?? null]);
      if ("refused" in read) throw new Fail(`Desk didn't read a key there: ${read.refused}.`);
      return read;
    }
    case "front": {
      const windowId = await tabs.windowId();
      if (windowId === null) throw new Fail("Desk's window isn't open.");
      await exec.front(windowId, tab);
      return exec.where(tab);
    }
  }
}

/** How long a hand-over waits for Chrome to say the tab is in front. */
const FRONT_MS = 1_500;

/** Hands `session`'s tab to the person and brings it to the front of their
 *  window. The answer says whether Chrome confirmed it's in front; once
 *  moved, the tab is theirs either way. */
async function handOver(session: string, tabs: DeskTabs, exec: Exec): Promise<unknown> {
  // The hub makes one call at a time per session, so nothing else acts on
  // this tab while it is handed over.
  // Never a fresh tab: only a page the hub just opened is handed over.
  const tab = await tabs.existing(session);
  if (tab === null) throw new Fail("Desk has no page open to hand over.");
  const at = await exec.where(tab);
  if (!workable(at.url)) throw new Fail("Desk's tab is on a page Desk doesn't work in.");
  const moved = await tabs.handOver(session);
  if (moved === null) throw new Fail("Desk has no page open to hand over.");
  let seen = { active: false, focused: false };
  try {
    await exec.raise(moved.windowId, moved.tabId);
    // Focus lands a moment after Chrome is asked for it.
    for (let waited = 0; ; waited += 100) {
      seen = await exec.inFront(moved.windowId, moved.tabId);
      if ((seen.active && seen.focused) || waited >= FRONT_MS) break;
      await exec.sleep(100);
    }
  } catch {
    // The tab is the person's now; it just isn't confirmed in front.
  }
  return { handed: true, ...seen, url: at.url, title: at.title };
}
