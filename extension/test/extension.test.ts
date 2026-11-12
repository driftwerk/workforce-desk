import { afterEach, describe, expect, it } from "vitest";
import fixture from "../protocol/v1.json";
import { Fail, perform, workable, type Exec } from "../src/commands";
import { DeskTabs, type ChromeTabs, type Kept } from "../src/desk";
import { labelOf } from "../src/identity";
import { Link, type Port } from "../src/link";
import { clickOn, fillField, onKeyPage, pressKey, readKey, readPage, selectOption, setFiles, shownOf, typeText } from "../src/page";
import { PROOF_PREFIX, PROTOCOL, fromHub, type Command, type ToHub } from "../src/protocol";

afterEach(() => {
  document.body.innerHTML = "";
});

/** Chrome's tabs, stood in for: windows hold tabs; nothing else exists. */
class FakeChrome implements ChromeTabs {
  next = 100;
  windows = new Map<number, { state: "normal" | "minimized"; tabs: number[] }>();
  groups: Record<number, number[]> = {};
  kept: Kept | null = null;
  personsTab = 1;
  async createWindow() {
    const windowId = this.next++;
    const tabId = this.next++;
    this.windows.set(windowId, { state: "normal", tabs: [tabId] });
    return { windowId, tabId };
  }
  async windowState(windowId: number) {
    return this.windows.get(windowId)?.state ?? "gone";
  }
  async createTab(windowId: number) {
    const id = this.next++;
    this.windows.get(windowId)!.tabs.push(id);
    return id;
  }
  async tabExists(tabId: number) {
    return [...this.windows.values()].some((w) => w.tabs.includes(tabId));
  }
  async group(_w: number, tabIds: number[], groupId: number | null) {
    const id = groupId ?? 900;
    this.groups[id] = [...(this.groups[id] ?? []), ...tabIds];
    return id;
  }
  async removeTab(tabId: number) {
    for (const w of this.windows.values()) w.tabs = w.tabs.filter((t) => t !== tabId);
  }
  async removeWindow(windowId: number) {
    this.windows.delete(windowId);
  }
  async activate() {}
  async focusWindow() {}
  async load() {
    return this.kept;
  }
  async save(k: Kept) {
    this.kept = structuredClone(k);
  }
}

/** Runs page functions against this test's document, as Chrome would in
 *  Desk's tab. */
const execOn = (url = "https://shop.example/cart"): Exec & { navigated: string[]; captured: number } => {
  const e = {
    navigated: [] as string[],
    captured: 0,
    at: url,
    async run<A extends unknown[], R>(_tab: number, func: (...args: A) => R, args: A) {
      return func(...args);
    },
    async navigate(_tab: number, to: string) {
      e.navigated.push(to);
      e.at = to;
    },
    async where() {
      return { url: e.at, title: document.title };
    },
    async capture() {
      e.captured++;
      return "data:image/png;base64,iVBORw0KGgo=";
    },
    async activate() {},
    async front() {},
    async sleep() {},
  };
  return e;
};

describe("the protocol", () => {
  it("reads every message the hub sends, and nothing else", () => {
    expect(fixture.protocol).toBe(PROTOCOL);
    expect(fixture.proof_prefix).toBe(PROOF_PREFIX);
    const from = fixture.from_hub;
    for (const m of [from.challenge, from.waiting, from.ready, from.refused, from.status, ...from.calls]) expect(fromHub(m)).toEqual(m);
    for (const bad of [null, "x", { type: "call", cmd: "click" }, { type: "challenge" }, { type: "exec" }]) expect(fromHub(bad)).toBeNull();
  });

  it("names every command the fixture holds, and the fixture holds every command", () => {
    const cmds = fixture.from_hub.calls.map((c) => c.cmd).sort();
    const known: Command["cmd"][] = ["capture", "capture_key", "click", "close", "fill", "front", "navigate", "open", "press", "read", "select", "shown", "stop", "type", "upload", "wait", "where"];
    expect(cmds).toEqual([...known].sort());
  });
});

describe("what a page may be", () => {
  it("is the web or a blank page, never Chrome's own pages, files, scripts or the Web Store", () => {
    for (const ok of ["https://shop.example/x", "http://127.0.0.1:8080/", "about:blank"]) expect(workable(ok)).toBe(true);
    for (const no of [
      "chrome://settings",
      "chrome-extension://abc/popup.html",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://chromewebstore.google.com/detail/x",
      "https://chrome.google.com/webstore/detail/x",
      "about:config",
      "not a url",
    ])
      expect(workable(no)).toBe(false);
  });
});

describe("Desk's tabs", () => {
  it("opens one window of its own, a tab per session in the Desk group, and never adopts the person's tabs", async () => {
    const c = new FakeChrome();
    const tabs = new DeskTabs(c);
    const a = await tabs.tabFor("allan");
    const b = await tabs.tabFor("ben");
    expect(c.windows.size).toBe(1);
    expect(a).not.toBe(b);
    expect(await tabs.tabFor("allan")).toBe(a);
    expect(c.groups[900]).toContain(b);
    expect(await tabs.owns(c.personsTab)).toBe(false);
    expect(await tabs.adopt(555, c.personsTab)).toBe(false);
    expect(await tabs.adopt(556, undefined)).toBe(false);
    // A popup Desk's page opened joins Desk, and becomes where it works.
    c.windows.get([...c.windows.keys()][0]!)!.tabs.push(557);
    expect(await tabs.adopt(557, a)).toBe(true);
    expect(await tabs.owns(557)).toBe(true);
    expect(await tabs.existing("allan")).toBe(557);
  });

  it("closes a session's tab, the window with its last, and Stop closes all", async () => {
    const c = new FakeChrome();
    const tabs = new DeskTabs(c);
    await tabs.tabFor("allan");
    await tabs.tabFor("ben");
    expect(await tabs.close("allan")).toBe(true);
    expect(c.windows.size).toBe(1);
    expect(await tabs.close("ben")).toBe(true);
    expect(c.windows.size).toBe(0);
    await tabs.tabFor("allan");
    expect(await tabs.stop()).toBe(1);
    expect(c.windows.size).toBe(0);
    expect(await tabs.sessions()).toEqual([]);
  });

  it("opens the window again when the person closed it, and remembers its tabs across the worker's restarts", async () => {
    const c = new FakeChrome();
    const first = new DeskTabs(c);
    const a = await first.tabFor("allan");
    const again = new DeskTabs(c);
    expect(await again.tabFor("allan")).toBe(a);
    c.windows.clear();
    const b = await again.tabFor("allan");
    expect(b).not.toBe(a);
    expect(c.windows.size).toBe(1);
  });
});

describe("page functions", () => {
  it("read the title and text, cap them, and read field values only when asked", () => {
    document.title = "Cart";
    document.body.innerHTML = `<p>Two items</p><input value="hidden-value">`;
    const text = readPage("text", 1000, 1000);
    expect(text.title).toBe("Cart");
    expect(text.html).toBeUndefined();
    expect(readPage("all", 1000, 1000).text).toContain("hidden-value");
    expect(readPage("html", 1000, 20).html!.length).toBe(20);
  });

  it("say what an element shows: its text, label, type and form action", () => {
    document.body.innerHTML = `<form action="/pay"><label for="c">Card number</label><input id="c" name="cc" autocomplete="cc-number"><button id="b">Pay now</button></form>`;
    expect(shownOf("#c", true)).toContain("Card number");
    expect(shownOf("#c", true)).toContain("cc-number");
    expect(shownOf("#c", true)).toContain("/pay");
    expect(shownOf("#b", false)).toContain("Pay now");
    expect(shownOf("#nope", false)).toBe("");
  });

  it("click what was asked, and say when it is missing", () => {
    document.body.innerHTML = `<button id="save">Save</button>`;
    let clicked = 0;
    document.getElementById("save")!.addEventListener("click", () => clicked++);
    // jsdom lays nothing out, so an element shows as having no size.
    expect(clickOn("#save")).toBe("hidden");
    expect(clickOn("#nope")).toBe("missing");
    const el = document.getElementById("save")!;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 50, height: 20 }) as DOMRect;
    // Something laid over the button takes the click: it isn't made.
    const cover = document.createElement("div");
    document.body.appendChild(cover);
    let atPoint: Element = cover;
    document.elementFromPoint = () => atPoint;
    expect(clickOn("#save")).toBe("covered");
    expect(clicked).toBe(0);
    atPoint = el;
    expect(clickOn("#save")).toBe("ok");
    expect(clicked).toBe(1);
  });

  it("fill, type, select and press as a person would, with the page's events", () => {
    document.body.innerHTML = `<form id="f"><input id="name"><input id="q"><select id="size"><option value="s">Small</option><option value="m">Medium</option></select></form>`;
    const seen: string[] = [];
    document.getElementById("name")!.addEventListener("input", () => seen.push("input"));
    document.getElementById("name")!.addEventListener("change", () => seen.push("change"));
    expect(fillField("#name", "Allan")).toBe(true);
    expect((document.getElementById("name") as HTMLInputElement).value).toBe("Allan");
    expect(seen).toEqual(["input", "change"]);
    expect(typeText("#q", "shoes")).toBe(true);
    expect((document.getElementById("q") as HTMLInputElement).value).toBe("shoes");
    expect(selectOption("#size", "Medium")).toBe(true);
    expect((document.getElementById("size") as HTMLSelectElement).value).toBe("m");
    expect(selectOption("#size", "Huge")).toBe(false);
    let submitted = 0;
    document.getElementById("f")!.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted++;
    });
    expect(pressKey("#q", "Enter")).toBe(true);
    expect(submitted).toBe(1);
  });

  it("give a file field files, and refuse anything else", () => {
    document.body.innerHTML = `<input id="f" type="file"><input id="t">`;
    if (typeof DataTransfer === "undefined") return;
    expect(setFiles("#t", [{ name: "a.txt", type: "text/plain", base64: "aGk=" }])).toBe(false);
  });
});

describe("calls", () => {
  it("work in the session's own tab, and refuse a page Desk doesn't work in", async () => {
    const tabs = new DeskTabs(new FakeChrome());
    const exec = execOn();
    await expect(perform({ cmd: "navigate", session: "s", url: "chrome://settings" }, tabs, exec)).rejects.toBeInstanceOf(Fail);
    await perform({ cmd: "navigate", session: "s", url: "https://shop.example/" }, tabs, exec);
    expect(exec.navigated).toEqual(["https://shop.example/"]);
    document.body.innerHTML = `<input id="name">`;
    expect(await perform({ cmd: "fill", session: "s", selector: "#name", value: "x" }, tabs, exec)).toBe(true);
    await expect(perform({ cmd: "fill", session: "s", selector: "#nope", value: "x" }, tabs, exec)).rejects.toThrow("Nothing on the page matches");
    const off = execOn("chrome://settings");
    await expect(perform({ cmd: "read", session: "s", what: "text" }, tabs, off)).rejects.toThrow("doesn't work in");
  });

  it("take no picture of a minimised window, and refuse an upload too big for Chrome", async () => {
    const c = new FakeChrome();
    const tabs = new DeskTabs(c);
    const exec = execOn();
    expect(await perform({ cmd: "capture", session: "s" }, tabs, exec)).toEqual({ png_base64: "iVBORw0KGgo=" });
    for (const w of c.windows.values()) w.state = "minimized";
    expect(await perform({ cmd: "capture", session: "s" }, tabs, exec)).toEqual({ skipped: "minimised" });
    expect(exec.captured).toBe(1);
    const big = "A".repeat(1_000_000);
    await expect(perform({ cmd: "upload", session: "s", selector: "#f", files: [{ name: "x", type: "", base64: big }] }, tabs, exec)).rejects.toThrow("too big");
  });

  it("wait for an element until it appears, or say it didn't", async () => {
    const tabs = new DeskTabs(new FakeChrome());
    const exec = execOn();
    document.body.innerHTML = `<p id="done"></p>`;
    expect(await perform({ cmd: "wait", session: "s", selector: "#done", timeout_ms: 50 }, tabs, exec)).toBe(true);
    await expect(perform({ cmd: "wait", session: "s", selector: "#never", timeout_ms: 0 }, tabs, exec)).rejects.toThrow("didn't appear");
  });
});

describe("the link to Desk", () => {
  const port = () => {
    const sent: ToHub[] = [];
    let take: (m: unknown) => void = () => undefined;
    let drop: (why: string | null) => void = () => undefined;
    const p: Port & { sent: ToHub[]; hub: (m: unknown) => Promise<void>; drop: (w: string | null) => void } = {
      sent,
      post: (m) => sent.push(m),
      onMessage: (f) => (take = f),
      onDisconnect: (f) => (drop = f),
      disconnect: () => undefined,
      hub: async (m) => {
        take(m);
        await new Promise((r) => setTimeout(r, 0));
      },
      drop: (w) => drop(w),
    };
    return p;
  };
  const me = { publicKey: "KEY", label: "AAAA-BBBB-CCCC-DDDD", sign: async (n: string) => `signed:${n}` };

  it("says who it is, signs the challenge, and does nothing until the person confirms this Chrome", async () => {
    const p = port();
    const later: (() => void)[] = [];
    const link = new Link(() => p, async () => me, new DeskTabs(new FakeChrome()), execOn(), "0.1.0", (f) => later.push(f));
    await link.start();
    expect(p.sent[0]).toEqual({ type: "hello", protocol: PROTOCOL, version: "0.1.0", key: "KEY", label: "AAAA-BBBB-CCCC-DDDD" });
    await p.hub({ type: "challenge", nonce: "n1", state: "pending" });
    expect(p.sent[1]).toEqual({ type: "proof", signature: "signed:n1" });
    expect(link.state.state).toBe("waiting");
    await p.hub({ type: "call", id: 1, cmd: "where", session: "s" });
    expect(p.sent[2]).toMatchObject({ type: "result", id: 1, ok: false });
    await p.hub({ type: "ready" });
    await p.hub({ type: "call", id: 2, cmd: "where", session: "s" });
    expect(p.sent[3]).toMatchObject({ type: "result", id: 2, ok: true });
    // Something that isn't the hub's is ignored.
    await p.hub({ type: "exec", code: "alert(1)" });
    expect(p.sent).toHaveLength(4);
    // Desk went away: it says so and tries again later.
    p.drop("Native host has exited.");
    expect(link.state.state).toBe("no-desk");
    expect(later).toHaveLength(1);
  });
});

describe("this Chrome's label", () => {
  it("is four groups of four from the key's SHA-256, and signs over the prefixed nonce", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
    expect(await labelOf(raw)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(PROOF_PREFIX + "n"));
    expect(new Uint8Array(sig)).toHaveLength(64);
  });
});

describe("reading a new key", () => {
  // jsdom's location is http://localhost:3000/ unless the test moves it.
  const origin = location.origin;
  const at = location.pathname;

  it("reads a readonly field or text on a key page, and nothing on any other page", () => {
    document.body.innerHTML = `<input id="k" readonly value=" lin_api_abcdef0123456789 "><code id="t">sk_live_text</code>`;
    expect(readKey("#k", origin, [at], 512)).toEqual({ value: "lin_api_abcdef0123456789", origin, path: at });
    const t = document.getElementById("t")!;
    t.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect;
    expect(readKey("#t", origin, [at], 512)).toMatchObject({ value: "sk_live_text" });
    expect(readKey("#k", "https://evil.example", [at], 512)).toEqual({ refused: "not a key page" });
    expect(readKey("#k", origin, ["/elsewhere"], 512)).toEqual({ refused: "not a key page" });
    expect(readKey("#k", origin, [at], 4)).toMatchObject({ value: "lin_" });
  });

  it("never reads an editable field, a password field, or a field in a form with a password", () => {
    document.body.innerHTML = `<input id="e" value="typed"><input id="p" type="password" readonly value="pw">
<input id="a" readonly autocomplete="current-password" value="pw2">
<form><input id="f" readonly value="k"><input type="password"></form>`;
    expect(readKey("#e", origin, [at], 512)).toEqual({ refused: "an editable field" });
    expect(readKey("#p", origin, [at], 512)).toEqual({ refused: "a password field" });
    expect(readKey("#a", origin, [at], 512)).toEqual({ refused: "a password field" });
    expect(readKey("#f", origin, [at], 512)).toEqual({ refused: "in a form with a password" });
    expect(readKey("#nope", origin, [at], 512)).toEqual({ refused: "missing" });
  });

  it("says whether the page is a key page now", () => {
    expect(onKeyPage([{ origin, paths: [at] }])).toBe(true);
    expect(onKeyPage([{ origin: "https://linear.app", paths: ["/"] }])).toBe(false);
  });

  it("takes no picture of a key page, and passes a refused read on plainly", async () => {
    const tabs = new DeskTabs(new FakeChrome());
    const exec = execOn();
    expect(await perform({ cmd: "capture", session: "s", refuse: [{ origin, paths: [at] }] }, tabs, exec)).toEqual({ skipped: "key page" });
    expect(exec.captured).toBe(0);
    document.body.innerHTML = `<input id="e" value="typed">`;
    await expect(perform({ cmd: "capture_key", session: "s", selector: "#e", origin, paths: [at] }, tabs, exec)).rejects.toThrow("an editable field");
  });
});

