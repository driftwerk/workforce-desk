import { afterEach, describe, expect, it } from "vitest";
import fixture from "../protocol/v1.json";
import helperFixture from "../protocol/desk-helper.json";
import { Fail, perform, workable, type Exec } from "../src/commands";
import { DeskTabs, type ChromeTabs, type Kept } from "../src/desk";
import { labelOf } from "../src/identity";
import { Link, type Port } from "../src/link";
import { clickOn, fillField, onKeyPage, pressKey, readKey, readPage, selectOption, setFiles, shownOf, typeText } from "../src/page";
import { PROOF_PREFIX, PROTOCOL, REVISION, fromHub, type Command, type ToHub } from "../src/protocol";
import { upToDate, type Reloader } from "../src/update";

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
  /** The person's own window; null for none. */
  persons: number | null = null;
  /** Gives the person a window of their own, holding their tab. */
  withPersonsWindow(): this {
    this.windows.set(50, { state: "normal", tabs: [this.personsTab] });
    this.persons = 50;
    return this;
  }
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
  async personsWindow(desk: number) {
    return this.persons !== null && this.persons !== desk && this.windows.has(this.persons) ? this.persons : null;
  }
  async moveTab(tabId: number, windowId: number) {
    for (const [id, w] of this.windows) {
      w.tabs = w.tabs.filter((t) => t !== tabId);
      // As Chrome does: a window left with no tab closes.
      if (w.tabs.length === 0 && id !== windowId) this.windows.delete(id);
    }
    for (const g of Object.keys(this.groups)) this.groups[Number(g)] = this.groups[Number(g)]!.filter((t) => t !== tabId);
    this.windows.get(windowId)!.tabs.push(tabId);
  }
  async windowWith(tabId: number) {
    const id = this.next++;
    this.windows.set(id, { state: "normal", tabs: [] });
    await this.moveTab(tabId, id);
    return id;
  }
  async load() {
    return this.kept;
  }
  async save(k: Kept) {
    this.kept = structuredClone(k);
  }
}

/** Runs page functions against this test's document, as Chrome would in
 *  Desk's tab. */
const execOn = (url = "https://shop.example/cart"): Exec & { navigated: string[]; captured: number; active: number | null; raised: number[]; front_: { active: boolean; focused: boolean } } => {
  const e = {
    navigated: [] as string[],
    raised: [] as number[],
    front_: { active: true, focused: true },
    captured: 0,
    at: url,
    active: null as number | null,
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
    async capture(_window: number, tab: number) {
      // As Chrome does: a picture of whichever tab is active now.
      await new Promise((r) => setTimeout(r, 5));
      if (e.active !== tab) return null;
      e.captured++;
      return "data:image/png;base64,iVBORw0KGgo=";
    },
    async activate(tab: number) {
      e.active = tab;
    },
    async front() {},
    async raise(windowId: number) {
      e.raised.push(windowId);
    },
    async inFront() {
      return e.front_;
    },
    async sleep() {},
  };
  return e;
};

describe("the protocol", () => {
  it("is the same file the hub reads, where the hub at hub.ref has it", async () => {
    const fsName = "node:fs";
    const { existsSync, readFileSync } = (await import(/* @vite-ignore */ fsName)) as {
      existsSync(p: URL): boolean;
      readFileSync(p: URL, encoding: string): string;
    };
    const hub = new URL("../../../workforce-public-desk/crates/hub/src/desk_chrome/protocol-v1.json", import.meta.url);
    if (!existsSync(hub)) return;
    expect(JSON.parse(readFileSync(hub, "utf8"))).toEqual(fixture);
  });

  it("reads every message the hub sends, and nothing else", () => {
    expect(fixture.protocol).toBe(PROTOCOL);
    expect(fixture.proof_prefix).toBe(PROOF_PREFIX);
    const from = fixture.from_hub;
    for (const m of [from.challenge, from.waiting, from.ready, from.refused, from.status, ...from.calls]) expect(fromHub(m)).toEqual(m);
    for (const bad of [null, "x", { type: "call", cmd: "click" }, { type: "challenge" }, { type: "exec" }]) expect(fromHub(bad)).toBeNull();
  });

  it("names every command the fixture holds, and the fixture holds every command", () => {
    const cmds = fixture.from_hub.calls.map((c) => c.cmd).sort();
    const known: Command["cmd"][] = ["capture", "capture_key", "click", "close", "fill", "front", "hand_over", "navigate", "open", "press", "read", "select", "shown", "stop", "type", "upload", "wait", "where"];
    expect(cmds).toEqual([...known].sort());
  });
});

describe("what Desk Helper and the extension say to each other", () => {
  it("stamps this build with the fixture's revision, and reads what Desk Helper says", () => {
    expect(REVISION).toBe(helperFixture.revision);
    expect(helperFixture.to_chrome.expects.revision).toBe(REVISION);
    expect(fromHub(helperFixture.to_chrome.expects)).toEqual(helperFixture.to_chrome.expects);
    expect(fromHub({ type: "expects", revision: "2" })).toBeNull();
    // The hello's other fields are the hub's, as v1.json has them.
    const { revision, ...hello } = helperFixture.from_chrome.hello;
    expect(revision).toBe(REVISION);
    expect(hello).toEqual(fixture.to_hub.hello);
  });

  it("is revised with the commands: a new one in v1.json is a new revision here", () => {
    // Adding a command fails this until `commands` is updated there, and
    // `revision` with it, so an unpacked build without it reloads.
    expect([...helperFixture.commands].sort()).toEqual(fixture.from_hub.calls.map((c) => c.cmd).sort());
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
    expect(fillField("#name", "Allan", location.origin)).toBe("ok");
    expect((document.getElementById("name") as HTMLInputElement).value).toBe("Allan");
    expect(seen).toEqual(["input", "change"]);
    expect(typeText("#q", "shoes", location.origin)).toBe("ok");
    expect((document.getElementById("q") as HTMLInputElement).value).toBe("shoes");
    // Only on the origin the hub resolved it for: a page that moved is left.
    expect(fillField("#name", "secret", "https://elsewhere.example")).toBe("moved");
    expect(typeText("#q", "secret", null)).toBe("moved");
    expect((document.getElementById("name") as HTMLInputElement).value).toBe("Allan");
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
    const here = location.origin;
    expect(await perform({ cmd: "fill", session: "s", selector: "#name", value: "x", origin: here }, tabs, exec)).toBe(true);
    await expect(perform({ cmd: "fill", session: "s", selector: "#nope", value: "x", origin: here }, tabs, exec)).rejects.toThrow("Nothing on the page matches");
    await expect(perform({ cmd: "fill", session: "s", selector: "#name", value: "x", origin: "https://other.example" }, tabs, exec)).rejects.toThrow("The page moved");
    const off = execOn("chrome://settings");
    await expect(perform({ cmd: "read", session: "s", what: "text" }, tabs, off)).rejects.toThrow("doesn't work in");
  });

  it("take no picture of a minimised window, and refuse an upload too big for Chrome", async () => {
    const c = new FakeChrome();
    const tabs = new DeskTabs(c);
    const exec = execOn();
    document.body.innerHTML = `<p>Basket</p>`;
    expect(await perform({ cmd: "capture", session: "s" }, tabs, exec)).toMatchObject({ png_base64: "iVBORw0KGgo=", url: location.href });
    for (const w of c.windows.values()) w.state = "minimized";
    expect(await perform({ cmd: "capture", session: "s" }, tabs, exec)).toEqual({ skipped: "minimised" });
    expect(exec.captured).toBe(1);
    const big = "A".repeat(1_000_000);
    await expect(perform({ cmd: "upload", session: "s", selector: "#f", files: [{ name: "x", type: "", base64: big }] }, tabs, exec)).rejects.toThrow("too big");
  });

  it("picture one tab at a time, and only the tab that is showing", async () => {
    const tabs = new DeskTabs(new FakeChrome());
    const exec = execOn();
    // Two sessions at once: each picture is of its own tab.
    const [a, b] = await Promise.all([perform({ cmd: "capture", session: "a" }, tabs, exec), perform({ cmd: "capture", session: "b" }, tabs, exec)]);
    expect(a).toHaveProperty("png_base64");
    expect(b).toHaveProperty("png_base64");
    expect(exec.captured).toBe(2);
    // Another tab came to the front before the picture: none is taken.
    const moved = execOn();
    moved.activate = async () => {
      moved.active = -1;
    };
    expect(await perform({ cmd: "capture", session: "a" }, tabs, moved)).toEqual({ skipped: "not_front" });
    expect(moved.captured).toBe(0);
  });

  it("wait for an element until it appears, or say it didn't", async () => {
    const tabs = new DeskTabs(new FakeChrome());
    const exec = execOn();
    document.body.innerHTML = `<p id="done"></p>`;
    expect(await perform({ cmd: "wait", session: "s", selector: "#done", timeout_ms: 50 }, tabs, exec)).toBe(true);
    await expect(perform({ cmd: "wait", session: "s", selector: "#never", timeout_ms: 0 }, tabs, exec)).rejects.toThrow("didn't appear");
  });
});

describe("handing a page to the person", () => {
  it("moves the session's tab to the front of the person's window, and lets go of it", async () => {
    const c = new FakeChrome().withPersonsWindow();
    const tabs = new DeskTabs(c);
    const exec = execOn("https://staging.example.com/");
    await perform({ cmd: "navigate", session: "s", url: "https://staging.example.com/" }, tabs, exec);
    const tab = (await tabs.existing("s"))!;
    const desk = (await tabs.windowId())!;
    const out = await perform({ cmd: "hand_over", session: "s" }, tabs, exec);
    expect(out).toEqual({ handed: true, active: true, focused: true, url: "https://staging.example.com/", title: document.title });
    expect(c.windows.get(50)!.tabs).toContain(tab);
    expect(exec.raised).toEqual([50]);
    // Theirs: no session's, not Desk's, never closed or adopted by Desk.
    expect(await tabs.existing("s")).toBeNull();
    expect(await tabs.owns(tab)).toBe(false);
    expect(await tabs.adopt(777, tab)).toBe(false);
    expect(await tabs.close("s")).toBe(false);
    expect(await tabs.stop()).toBe(0);
    expect(c.windows.get(50)!.tabs).toContain(tab);
    // Desk's window, now holding no session, is gone.
    expect(c.windows.has(desk)).toBe(false);
    // The agent's next call gets a tab of its own again.
    expect(await tabs.tabFor("s")).not.toBe(tab);
  });

  it("keeps Desk's window for the sessions still in it", async () => {
    const c = new FakeChrome().withPersonsWindow();
    const tabs = new DeskTabs(c);
    const other = await tabs.tabFor("other");
    await tabs.tabFor("s");
    await perform({ cmd: "hand_over", session: "s" }, tabs, execOn());
    expect(await tabs.existing("other")).toBe(other);
    expect(c.windows.get((await tabs.windowId())!)!.tabs).toContain(other);
  });

  it("opens a window of the person's own when they have none but Desk's", async () => {
    const c = new FakeChrome();
    const tabs = new DeskTabs(c);
    const exec = execOn();
    const tab = await tabs.tabFor("s");
    const desk = (await tabs.windowId())!;
    expect(await perform({ cmd: "hand_over", session: "s" }, tabs, exec)).toMatchObject({ handed: true, focused: true });
    const into = exec.raised[0]!;
    expect(into).not.toBe(desk);
    expect(c.windows.get(into)!.tabs).toEqual([tab]);
  });

  it("says when Chrome doesn't confirm it's in front, and never opens a tab to hand over", async () => {
    const tabs = new DeskTabs(new FakeChrome().withPersonsWindow());
    const behind = execOn();
    behind.front_ = { active: true, focused: false };
    await tabs.tabFor("s");
    expect(await perform({ cmd: "hand_over", session: "s" }, tabs, behind)).toMatchObject({ handed: true, focused: false });
    await expect(perform({ cmd: "hand_over", session: "none" }, tabs, execOn())).rejects.toThrow("no page open");
    expect(await tabs.existing("none")).toBeNull();
    await tabs.tabFor("off");
    await expect(perform({ cmd: "hand_over", session: "off" }, tabs, execOn("chrome://settings"))).rejects.toThrow("doesn't work in");
    expect(await tabs.existing("off")).not.toBeNull();
  });
});

describe("handing a page over when Desk's books can't be saved", () => {
  it("still says where the tab went, and forgets it", async () => {
    const c = new FakeChrome().withPersonsWindow();
    const tabs = new DeskTabs(c);
    await tabs.tabFor("other");
    const tab = await tabs.tabFor("s");
    const save = c.save.bind(c);
    c.save = async () => {
      throw new Error("storage is full");
    };
    expect(await perform({ cmd: "hand_over", session: "s" }, tabs, execOn())).toMatchObject({ handed: true });
    expect(c.windows.get(50)!.tabs).toContain(tab);
    expect(await tabs.existing("s")).toBeNull();
    c.save = save;
    expect(await tabs.closed(tab)).toBeNull();
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
    expect(p.sent[0]).toEqual({ type: "hello", protocol: PROTOCOL, revision: REVISION, version: "0.1.0", key: "KEY", label: "AAAA-BBBB-CCCC-DDDD" });
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

describe("bringing an unpacked build up to date", () => {
  const port = () => {
    const sent: ToHub[] = [];
    let take: (m: unknown) => void = () => undefined;
    const p: Port & { sent: ToHub[]; hub: (m: unknown) => Promise<void> } = {
      sent,
      post: (m) => sent.push(m),
      onMessage: (f) => (take = f),
      onDisconnect: () => undefined,
      disconnect: () => undefined,
      hub: async (m) => {
        take(m);
        await new Promise((r) => setTimeout(r, 0));
      },
    };
    return p;
  };
  const me = { publicKey: "KEY", label: "AAAA-BBBB-CCCC-DDDD", sign: async (n: string) => `signed:${n}` };
  /** Chrome's management, storage.local and runtime.reload, stood in for. */
  class FakeReloader implements Reloader {
    stored: number | null = null;
    reloads = 0;
    /** The rebuilt files on disk: a newer revision than any build here. */
    disk: number | null = 99;
    constructor(public install: string) {}
    async onDisk() {
      return this.disk;
    }
    async installType() {
      return this.install;
    }
    async reloadedFor() {
      return this.stored;
    }
    async remember(r: number) {
      this.stored = r;
    }
    reload() {
      this.reloads++;
    }
  }
  /** A connection of a build at `revision`, Desk Helper expecting `expects`:
   *  what the extension told it, with whatever it left for later run. */
  const connect = async (r: FakeReloader, revision: number, expects: number, chrome = new FakeChrome()) => {
    const p = port();
    const later: (() => void)[] = [];
    const link = new Link(() => p, async () => me, new DeskTabs(chrome), execOn(), "0.1.0", (f) => later.push(f), r, revision);
    await link.start();
    expect(p.sent[0]).toMatchObject({ type: "hello", revision });
    await p.hub({ type: "expects", revision: expects });
    for (const f of later.splice(0)) f();
    return p.sent.slice(1);
  };

  it("reloads a stale unpacked build once, telling Desk Helper first, and closes Desk's window", async () => {
    const r = new FakeReloader("development");
    const chrome = new FakeChrome();
    const tabs = new DeskTabs(chrome);
    await tabs.tabFor("s");
    const said = await connect(r, 1, 2, chrome);
    expect(said).toEqual([{ type: "updating", revision: 2, outcome: "reloading" }]);
    expect(r.reloads).toBe(1);
    expect(r.stored).toBe(2);
    expect(chrome.windows.size).toBe(0);
  });

  it("doesn't loop: the same old files after a reload are said, not reloaded again", async () => {
    const r = new FakeReloader("development");
    await connect(r, 1, 2);
    // Chrome started it again from disk, and the files were still old.
    const again = await connect(r, 1, 2);
    expect(again).toEqual([{ type: "updating", revision: 2, outcome: "tried" }]);
    expect(r.reloads).toBe(1);
    const andAgain = await connect(r, 1, 2);
    expect(andAgain[0]).toMatchObject({ outcome: "tried" });
    expect(r.reloads).toBe(1);
    // A Desk expecting newer still gets its one reload.
    await connect(r, 2, 3);
    expect(r.reloads).toBe(2);
  });

  it("waits, without spending its one try, while the files on disk aren't rebuilt yet, and looks again", async () => {
    const r = new FakeReloader("development");
    r.disk = null;
    const p = port();
    const later: (() => void)[] = [];
    const link = new Link(() => p, async () => me, new DeskTabs(new FakeChrome()), execOn(), "0.1.0", (f) => later.push(f), r, 1);
    await link.start();
    // Desk Helper says it once, on this connection; said again, it starts
    // no second look.
    await p.hub({ type: "expects", revision: 2 });
    await p.hub({ type: "expects", revision: 2 });
    expect(p.sent.slice(1)).toEqual([{ type: "updating", revision: 2, outcome: "unbuilt" }]);
    expect(later).toHaveLength(1);
    const tick = async () => {
      for (const f of later.splice(0)) f();
      await new Promise((res) => setTimeout(res, 0));
    };
    // Mid-build, then the old files: it keeps looking, and says nothing new.
    for (const disk of [null, 1]) {
      r.disk = disk;
      await tick();
      expect(p.sent).toHaveLength(2);
      expect(later).toHaveLength(1);
    }
    expect(r.reloads).toBe(0);
    expect(r.stored).toBeNull();
    // The build finished: it reloads into it, with no new connection.
    r.disk = 2;
    await tick();
    expect(p.sent.slice(2)).toEqual([{ type: "updating", revision: 2, outcome: "reloading" }]);
    await tick();
    expect(r.reloads).toBe(1);
    expect(later).toHaveLength(0);
  });

  it("never reloads a Web Store install", async () => {
    for (const install of ["normal", "sideload", "admin", "other"]) {
      const r = new FakeReloader(install);
      expect(await connect(r, 1, 2)).toEqual([{ type: "updating", revision: 2, outcome: "store" }]);
      expect(r.reloads).toBe(0);
      expect(r.stored).toBeNull();
    }
  });

  it("leaves a current build alone, and says nothing", async () => {
    for (const expects of [1, 2]) {
      const r = new FakeReloader("development");
      expect(await connect(r, 2, expects)).toEqual([]);
      expect(r.reloads).toBe(0);
      expect(r.stored).toBeNull();
    }
    expect(await upToDate(2, 2, new FakeReloader("development"))).toBe("current");
  });

  it("ignores what Desk Helper expects when it has no way to reload", async () => {
    const p = port();
    const link = new Link(() => p, async () => me, new DeskTabs(new FakeChrome()), execOn(), "0.1.0", () => undefined);
    await link.start();
    await p.hub({ type: "expects", revision: REVISION + 1 });
    expect(p.sent).toHaveLength(1);
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
    document.getElementById("k")!.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect;
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

  it("reads nothing the person can't see, nor a field named for a password", () => {
    document.body.innerHTML = `<input id="h" type="hidden" readonly value="k1"><input id="z" readonly value="k2">
<div style="display:none"><input id="d" readonly value="k3"></div><input id="o" readonly style="opacity:0" value="k4">
<input id="v" readonly style="visibility:hidden" value="k5"><input id="n" name="user_pass" readonly value="k6"><input id="passkey" readonly value="k7">`;
    const sized = (id: string) => (document.getElementById(id)!.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect);
    for (const id of ["h", "d", "o", "v", "n", "passkey"]) sized(id);
    for (const id of ["h", "z", "d", "o", "v"]) expect(readKey(`#${id}`, origin, [at], 512), id).toEqual({ refused: "hidden" });
    for (const id of ["n", "passkey"]) expect(readKey(`#${id}`, origin, [at], 512), id).toEqual({ refused: "a password field" });
  });

  it("holds a key page's paths a whole segment at a time", () => {
    history.replaceState(null, "", "/settings/api/new");
    try {
      document.body.innerHTML = `<code id="t">sk_live_text</code>`;
      document.getElementById("t")!.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect;
      expect(readKey("#t", origin, ["/settings/ap"], 512)).toEqual({ refused: "not a key page" });
      expect(readKey("#t", origin, ["/settings/api/newer"], 512)).toEqual({ refused: "not a key page" });
      expect(readKey("#t", origin, ["/settings/api"], 512)).toMatchObject({ value: "sk_live_text" });
      expect(readKey("#t", origin, ["/settings/api/"], 512)).toMatchObject({ value: "sk_live_text" });
      expect(onKeyPage([{ origin, paths: ["/settings/ap"] }])).toBe(false);
      expect(onKeyPage([{ origin, paths: ["/settings"] }])).toBe(true);
    } finally {
      history.replaceState(null, "", at);
    }
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

