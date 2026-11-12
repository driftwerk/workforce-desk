// Each call the hub makes, done in Desk's own tab. What a page may be is
// checked here too (the web, or a blank page), though the hub decides it
// first: the extension never opens or runs in Chrome's own pages, files,
// scripts or the Web Store.

import type { DeskTabs } from "./desk";
import { clickOn, fillField, focused, onKeyPage, present, pressKey, readKey, readPage, selectOption, setFiles, shownOf, typeText } from "./page";
import { MAX_HTML, MAX_KEY, MAX_TEXT, MAX_UPLOAD_BYTES, type Command } from "./protocol";

/** The parts of Chrome's API calls use, so tests can stand in. */
export interface Exec {
  /** Runs `func(...args)` in `tabId`'s page, in the isolated world. */
  run<A extends unknown[], R>(tabId: number, func: (...args: A) => R, args: A): Promise<R>;
  /** Loads `url` in `tabId` and waits for it (or `timeoutMs`). */
  navigate(tabId: number, url: string, timeoutMs: number): Promise<void>;
  where(tabId: number): Promise<{ url: string; title: string }>;
  /** A PNG of `windowId`'s active tab, as a data URL. */
  capture(windowId: number): Promise<string>;
  activate(tabId: number): Promise<void>;
  front(windowId: number, tabId: number): Promise<void>;
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

/** Does `c`, answering what it returns. */
export async function perform(c: Command, tabs: DeskTabs, exec: Exec): Promise<unknown> {
  if (c.cmd === "stop") return { closed: await tabs.stop() };
  if (c.cmd === "close") return { closed: await tabs.close(c.session) };
  if (c.cmd === "open") {
    const tab = await tabs.tabFor(c.session);
    return exec.where(tab);
  }
  // Every other call works in the session's tab, which it opens when needed.
  const tab = await tabs.tabFor(c.session);
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
    case "where":
      return exec.where(tab);
    case "read": {
      await here();
      return exec.run(tab, readPage, [c.what, MAX_TEXT, MAX_HTML]);
    }
    case "shown":
      await here();
      return exec.run(tab, shownOf, [c.selector, c.form]);
    case "click": {
      await here();
      const done = await exec.run(tab, clickOn, [c.selector]);
      if (done === "missing") throw new Fail(`Nothing on the page matches \`${c.selector}\`.`);
      if (done === "hidden") throw new Fail(`\`${c.selector}\` isn't showing, so it wasn't clicked.`);
      if (done === "covered") throw new Fail(`Something else lies over \`${c.selector}\`, so it wasn't clicked.`);
      return true;
    }
    case "fill": {
      await here();
      if (!(await exec.run(tab, fillField, [c.selector, c.value]))) throw new Fail(`Nothing on the page matches \`${c.selector}\`.`);
      return true;
    }
    case "type": {
      await here();
      if (c.selector && !(await exec.run(tab, focused, [c.selector]))) {
        // Typing goes only where the field has the focus.
        await exec.run(tab, typeText, [c.selector, ""]);
        if (!(await exec.run(tab, focused, [c.selector]))) throw new Fail(`\`${c.selector}\` didn't take the focus, so nothing was typed.`);
      }
      if (!(await exec.run(tab, typeText, [c.selector, c.text]))) throw new Fail("There's nothing to type into.");
      return true;
    }
    case "press": {
      await here();
      if (!(await exec.run(tab, pressKey, [c.selector, c.key]))) throw new Fail("There's nothing to press the key on.");
      return true;
    }
    case "select": {
      await here();
      if (!(await exec.run(tab, selectOption, [c.selector, c.value]))) throw new Fail(`\`${c.selector}\` has no option \`${c.value}\`.`);
      return true;
    }
    case "wait": {
      const until = Date.now() + Math.min(Math.max(c.timeout_ms, 0), 120_000);
      let pause = 100;
      for (;;) {
        const at = await exec.where(tab);
        if (workable(at.url) && (await exec.run(tab, present, [c.selector]).catch(() => false))) return true;
        if (Date.now() >= until) throw new Fail(`\`${c.selector}\` didn't appear in time.`);
        await exec.sleep(pause);
        pause = Math.min(pause * 2, 1000);
      }
    }
    case "upload": {
      await here();
      const bytes = c.files.reduce((n, f) => n + Math.floor((f.base64.length * 3) / 4), 0);
      if (bytes > MAX_UPLOAD_BYTES) throw new Fail("Those files are too big for Desk to hand to Chrome in one go.");
      if (!(await exec.run(tab, setFiles, [c.selector, c.files]))) throw new Fail(`\`${c.selector}\` isn't a file field.`);
      return true;
    }
    case "capture": {
      await here();
      // A minimised window is never restored behind the person's back.
      if (await tabs.minimised()) return { skipped: "minimised" };
      const windowId = await tabs.windowId();
      if (windowId === null) throw new Fail("Desk's window isn't open.");
      await exec.activate(tab);
      // A key page is never pictured: its address read again right now.
      if (c.refuse?.length && (await exec.run(tab, onKeyPage, [c.refuse]))) return { skipped: "key page" };
      const data = await exec.capture(windowId);
      return { png_base64: data.replace(/^data:image\/png;base64,/, "") };
    }
    case "capture_key": {
      await here();
      const read = await exec.run(tab, readKey, [c.selector, c.origin, c.paths, MAX_KEY]);
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
