// The service worker: Chrome's side of the parts in desk.ts, commands.ts
// and link.ts. An open native messaging port keeps it alive (Chrome 105+);
// when Desk Helper goes away it reconnects.

import type { Exec } from "./commands";
import { DeskTabs, type ChromeTabs, type Kept } from "./desk";
import { identity, type Identity } from "./identity";
import { HOST, Link, type LinkState, type Port } from "./link";
import { REVISION, type ToHub } from "./protocol";
import type { Reloader } from "./update";

const KEPT = "desk";
/** The revision this extension last reloaded itself for (`storage.local`). */
const RELOADED_FOR = "reloadedFor";
/** The person's own window they used last (`storage.session`). */
const PERSONS = "persons";

const tabsApi: ChromeTabs = {
  async createWindow() {
    const w = await chrome.windows.create({ url: "about:blank", focused: false, type: "normal", width: 1200, height: 900 });
    const tabId = w?.tabs?.[0]?.id;
    if (w?.id === undefined || tabId === undefined) throw new Error("Chrome didn't open Desk's window");
    return { windowId: w.id, tabId };
  },
  async windowState(windowId) {
    try {
      const w = await chrome.windows.get(windowId);
      return (w.state as "normal" | "minimized" | "maximized" | "fullscreen") ?? "normal";
    } catch {
      return "gone";
    }
  },
  async createTab(windowId) {
    const t = await chrome.tabs.create({ windowId, url: "about:blank", active: false });
    if (t.id === undefined) throw new Error("Chrome didn't open a tab");
    return t.id;
  },
  async tabExists(tabId) {
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  },
  async group(windowId, tabIds, groupId) {
    const [first, ...rest] = tabIds;
    if (first === undefined) throw new Error("no tab to group");
    const ids: [number, ...number[]] = [first, ...rest];
    const id: number = await (groupId === null ? chrome.tabs.group({ tabIds: ids, createProperties: { windowId } }) : chrome.tabs.group({ tabIds: ids, groupId }));
    if (groupId === null) await chrome.tabGroups.update(id, { title: "Desk", color: "green" });
    return id;
  },
  removeTab: (tabId) => chrome.tabs.remove(tabId),
  removeWindow: (windowId) => chrome.windows.remove(windowId),
  activate: async (tabId) => void (await chrome.tabs.update(tabId, { active: true })),
  focusWindow: async (windowId) => void (await chrome.windows.update(windowId, { focused: true })),
  async personsWindow(desk) {
    const theirs = (w: chrome.windows.Window | null | undefined): w is chrome.windows.Window & { id: number } => !!w && w.id !== undefined && w.id !== desk && w.type === "normal" && !w.incognito;
    // The window the person last used that isn't Desk's, as noted when it
    // took the focus; Chrome's own "last focused" may be Desk's.
    const noted = ((await chrome.storage.session.get(PERSONS))[PERSONS] as number | undefined) ?? null;
    const was = noted === null ? null : await chrome.windows.get(noted).catch(() => null);
    if (theirs(was)) return was.id;
    const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    if (theirs(last)) return last.id;
    const all = (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter(theirs);
    return (all.find((w) => w.state !== "minimized") ?? all[0])?.id ?? null;
  },
  async moveTab(tabId, windowId) {
    await chrome.tabs.ungroup(tabId).catch(() => undefined);
    await chrome.tabs.move(tabId, { windowId, index: -1 });
  },
  async windowWith(tabId) {
    await chrome.tabs.ungroup(tabId).catch(() => undefined);
    const w = await chrome.windows.create({ tabId, focused: true, type: "normal" });
    if (w?.id === undefined) throw new Error("Chrome didn't open a window");
    return w.id;
  },
  load: async () => ((await chrome.storage.session.get(KEPT))[KEPT] as Kept | undefined) ?? null,
  save: (kept) => chrome.storage.session.set({ [KEPT]: kept }),
};

/** Chrome allows two pictures a second; Desk takes one at a time. */
let lastCapture = 0;

const exec: Exec = {
  async run(tabId, func, args) {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func, args });
    return r?.result as never;
  },
  navigate: (tabId, url, timeoutMs) =>
    new Promise((resolve, reject) => {
      const done = (tid: number, info: { status?: string }) => {
        if (tid === tabId && info.status === "complete") {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(done);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }, timeoutMs);
      chrome.tabs.onUpdated.addListener(done);
      chrome.tabs.update(tabId, { url }).catch((e) => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(done);
        reject(e);
      });
    }),
  async where(tabId) {
    const t = await chrome.tabs.get(tabId);
    return { url: t.url ?? t.pendingUrl ?? "about:blank", title: t.title ?? "" };
  },
  async capture(windowId, tabId) {
    const wait = lastCapture + 550 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCapture = Date.now();
    // Right before the picture: the window's active tab is Desk's.
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active?.id !== tabId) return null;
    return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  },
  activate: async (tabId) => void (await chrome.tabs.update(tabId, { active: true })),
  async front(windowId, tabId) {
    await chrome.windows.update(windowId, { focused: true, state: "normal" });
    await chrome.tabs.update(tabId, { active: true });
  },
  async raise(windowId, tabId) {
    await chrome.tabs.update(tabId, { active: true });
    const w = await chrome.windows.get(windowId);
    await chrome.windows.update(windowId, w.state === "minimized" ? { focused: true, state: "normal" } : { focused: true });
  },
  async inFront(windowId, tabId) {
    const [t, w] = await Promise.all([chrome.tabs.get(tabId), chrome.windows.get(windowId)]);
    return { active: t.active && t.windowId === windowId, focused: w.focused && w.state !== "minimized" };
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const nativePort = (): Port => {
  const p = chrome.runtime.connectNative(HOST);
  return {
    post: (m: ToHub) => p.postMessage(m),
    onMessage: (f) => p.onMessage.addListener(f),
    onDisconnect: (f) => p.onDisconnect.addListener(() => f(chrome.runtime.lastError?.message ?? null)),
    disconnect: () => p.disconnect(),
  };
};

const reloader: Reloader = {
  // getSelf needs no permission; a Chrome without it never reloads this.
  installType: async () => (chrome.management?.getSelf ? (await chrome.management.getSelf()).installType : "unknown"),
  reloadedFor: async () => ((await chrome.storage.local.get(RELOADED_FOR))[RELOADED_FOR] as number | undefined) ?? null,
  remember: (revision) => chrome.storage.local.set({ [RELOADED_FOR]: revision }),
  reload: () => {
    console.info(`Desk expects a newer extension than this one (revision ${REVISION}): reloading it from disk.`);
    chrome.runtime.reload();
  },
};

let me: Promise<Identity> | null = null;
const tabs = new DeskTabs(tabsApi);
const link = new Link(nativePort, () => (me ??= identity()), tabs, exec, chrome.runtime.getManifest().version, (f, ms) => setTimeout(f, ms), reloader);

const badge = (s: LinkState) => {
  void chrome.action.setBadgeText({ text: s.state === "ready" ? (s.activity ? "●" : "") : s.state === "waiting" ? "!" : "" });
  void chrome.action.setBadgeBackgroundColor({ color: "#3d7a3a" });
};
link.onChange(badge);

// A tab a page of Desk's opens joins Desk; any other is left alone.
chrome.tabs.onCreated.addListener((t) => {
  if (t.id !== undefined) void tabs.adopt(t.id, t.openerTabId);
});
// The person's own window, each time one takes the focus: where a page
// opened for them goes.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void tabs.windowId().then(async (desk) => {
    if (windowId === desk) return;
    const w = await chrome.windows.get(windowId).catch(() => null);
    if (w?.type === "normal" && !w.incognito) await chrome.storage.session.set({ [PERSONS]: windowId });
  });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void tabs.closed(tabId).then((session) => {
    if (session) link.tabClosed(session);
  });
});

// Only this extension's own popup talks to the worker.
chrome.runtime.onMessage.addListener((msg: { ask?: string }, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("popup.html"))) return false;
  if (msg.ask === "state") {
    reply(link.state);
    return false;
  }
  if (msg.ask === "stop") {
    void link.stop().then(() => reply(link.state));
    return true;
  }
  return false;
});

let started = false;
const start = () => {
  if (started) return;
  started = true;
  void link.start();
};
chrome.runtime.onStartup.addListener(start);
chrome.runtime.onInstalled.addListener(start);
start();
