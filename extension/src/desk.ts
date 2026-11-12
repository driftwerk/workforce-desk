// Where Desk works in the person's Chrome: a normal window of its own, its
// tabs in a group titled "Desk". Each of Desk's browser sessions (one per
// agent and person, named by the hub) has a tab there. The extension only
// ever acts on a tab it opened and still holds: a session's tab, or a tab
// one of those opened (a page's popup). There is no way to name any other
// tab. A page an agent opens *for* the person is handed over: its tab moves
// to the person's own window and Desk lets go of it for good.

/** The parts of Chrome's API Desk's tabs use, so tests can stand in. */
export interface ChromeTabs {
  createWindow(): Promise<{ windowId: number; tabId: number }>;
  windowState(windowId: number): Promise<"normal" | "minimized" | "maximized" | "fullscreen" | "gone">;
  createTab(windowId: number): Promise<number>;
  tabExists(tabId: number): Promise<boolean>;
  group(windowId: number, tabIds: number[], groupId: number | null): Promise<number>;
  removeTab(tabId: number): Promise<void>;
  removeWindow(windowId: number): Promise<void>;
  activate(tabId: number): Promise<void>;
  focusWindow(windowId: number): Promise<void>;
  /** The person's own window to hand a tab to: the normal window they used
   *  last that isn't `desk`, else any other; null when there's none. */
  personsWindow(desk: number): Promise<number | null>;
  /** Moves `tabId`, out of Desk's group, to the end of `windowId`. */
  moveTab(tabId: number, windowId: number): Promise<void>;
  /** A new normal window holding `tabId`, out of Desk's group. */
  windowWith(tabId: number): Promise<number>;
  load(): Promise<Kept | null>;
  save(kept: Kept): Promise<void>;
}

/** What is kept for the session of the browser (`storage.session`). */
export interface Kept {
  windowId: number;
  groupId: number | null;
  /** Each session's tab. */
  sessions: Record<string, number>;
  /** Tabs Desk's pages opened, by the session whose page opened them. */
  opened: Record<number, string>;
}

export class DeskTabs {
  private kept: Kept | null = null;
  private loaded = false;

  constructor(private readonly chrome: ChromeTabs) {}

  private async state(): Promise<Kept | null> {
    if (!this.loaded) {
      this.kept = await this.chrome.load();
      this.loaded = true;
    }
    return this.kept;
  }

  private async keep(k: Kept | null): Promise<void> {
    this.kept = k;
    if (k) await this.chrome.save(k);
    else await this.chrome.save({ windowId: -1, groupId: null, sessions: {}, opened: {} });
  }

  /** Desk's window, opened (without taking the focus) when it isn't open. */
  private async window(): Promise<Kept> {
    const k = await this.state();
    if (k && k.windowId >= 0 && (await this.chrome.windowState(k.windowId)) !== "gone") return k;
    const { windowId, tabId } = await this.chrome.createWindow();
    const groupId = await this.chrome.group(windowId, [tabId], null);
    const fresh: Kept = { windowId, groupId, sessions: {}, opened: {} };
    // The window's first tab is the first session's, once one asks.
    fresh.opened[tabId] = "";
    await this.keep(fresh);
    return fresh;
  }

  /** `session`'s tab, opened in Desk's window when it has none. */
  async tabFor(session: string): Promise<number> {
    const k = await this.window();
    const had = k.sessions[session];
    if (had !== undefined && (await this.chrome.tabExists(had))) return had;
    // A blank first tab nobody has taken yet goes to this session.
    const spare = Object.entries(k.opened).find(([, by]) => by === "");
    let tabId: number;
    if (spare && (await this.chrome.tabExists(Number(spare[0])))) {
      tabId = Number(spare[0]);
      delete k.opened[tabId];
    } else {
      tabId = await this.chrome.createTab(k.windowId);
      k.groupId = await this.chrome.group(k.windowId, [tabId], k.groupId);
    }
    k.sessions[session] = tabId;
    await this.keep(k);
    return tabId;
  }

  /** `session`'s tab if it has one open now; no tab is opened for it. */
  async existing(session: string): Promise<number | null> {
    const k = await this.state();
    const had = k?.sessions[session];
    return had !== undefined && (await this.chrome.tabExists(had)) ? had : null;
  }

  /** Whether `tabId` is one of Desk's. */
  async owns(tabId: number): Promise<boolean> {
    const k = await this.state();
    if (!k) return false;
    return Object.values(k.sessions).includes(tabId) || tabId in k.opened;
  }

  /** A tab Desk's page opened (`opener`) joins Desk's group, and becomes
   *  where that session works, as a person follows a link that opens a new
   *  tab. Any other new tab is left alone. */
  async adopt(tabId: number, opener: number | undefined): Promise<boolean> {
    const k = await this.state();
    if (!k || opener === undefined) return false;
    const session = Object.entries(k.sessions).find(([, t]) => t === opener)?.[0] ?? k.opened[opener];
    if (session === undefined || session === "") return false;
    k.opened[opener] = session;
    k.sessions[session] = tabId;
    k.groupId = await this.chrome.group(k.windowId, [tabId], k.groupId);
    await this.keep(k);
    return true;
  }

  /** The person closed a tab: the session it was, if it was Desk's. */
  async closed(tabId: number): Promise<string | null> {
    const k = await this.state();
    if (!k) return null;
    const session = Object.entries(k.sessions).find(([, t]) => t === tabId)?.[0] ?? null;
    if (session !== null) delete k.sessions[session];
    delete k.opened[tabId];
    await this.keep(k);
    return session;
  }

  /** Closes `session`'s tab, and Desk's window once it holds none. */
  async close(session: string): Promise<boolean> {
    const k = await this.state();
    const tabId = k?.sessions[session];
    if (!k || tabId === undefined) return false;
    delete k.sessions[session];
    for (const [t, by] of Object.entries(k.opened)) if (by === session) delete k.opened[Number(t)];
    await this.chrome.removeTab(tabId).catch(() => undefined);
    if (Object.keys(k.sessions).length === 0) {
      await this.chrome.removeWindow(k.windowId).catch(() => undefined);
      await this.keep(null);
    } else await this.keep(k);
    return true;
  }

  /** Stop: every tab of Desk's closes, and its window. How many sessions
   *  had one. */
  async stop(): Promise<number> {
    const k = await this.state();
    if (!k || k.windowId < 0) return 0;
    const n = Object.keys(k.sessions).length;
    await this.chrome.removeWindow(k.windowId).catch(() => undefined);
    await this.keep(null);
    return n;
  }

  /** Hands `session`'s tab to the person: it moves to their own window
   *  (a new one when they have none but Desk's), and is no session's from
   *  then on. Nothing Desk does closes or drives it again, and what it opens
   *  isn't adopted. Desk's window goes once it holds no session. Where the
   *  tab went; null when the session has no tab. */
  async handOver(session: string): Promise<{ tabId: number; windowId: number } | null> {
    const k = await this.state();
    const tabId = k?.sessions[session];
    if (!k || tabId === undefined || !(await this.chrome.tabExists(tabId))) return null;
    const into = await this.chrome.personsWindow(k.windowId);
    let windowId: number;
    if (into === null) windowId = await this.chrome.windowWith(tabId);
    else {
      await this.chrome.moveTab(tabId, into);
      windowId = into;
    }
    // Moved: it is the person's now, whatever happens to Desk's books.
    delete k.sessions[session];
    delete k.opened[tabId];
    for (const [t, by] of Object.entries(k.opened)) if (by === session) delete k.opened[Number(t)];
    try {
      if (Object.keys(k.sessions).length === 0) {
        await this.chrome.removeWindow(k.windowId).catch(() => undefined);
        await this.keep(null);
      } else await this.keep(k);
    } catch {
      // What is kept couldn't be saved; it is kept in memory all the same.
    }
    return { tabId, windowId };
  }

  /** Whether Desk's window is minimised: no picture is taken of it then,
   *  and it is never restored behind the person's back. */
  async minimised(): Promise<boolean> {
    const k = await this.state();
    return !!k && (await this.chrome.windowState(k.windowId)) === "minimized";
  }

  async windowId(): Promise<number | null> {
    const k = await this.state();
    return k && k.windowId >= 0 ? k.windowId : null;
  }

  /** The sessions with a tab open now. */
  async sessions(): Promise<string[]> {
    const k = await this.state();
    return k ? Object.keys(k.sessions) : [];
  }
}
