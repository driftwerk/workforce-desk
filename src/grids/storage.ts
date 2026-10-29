// Where grids are kept: the hub's Desk state store (`/api/desk/state`), so
// they come back after a hub restart, a quit, a crash or a restart of the
// Mac, with a copy on this Mac for before the hub answers and for a hub that
// has no state store yet.
//
// Grids only need `GridStorage` — get, set, remove and watch, by key — which
// is the public face of Desk's own restore store (restore/store.ts) as well;
// `KeptState` below is the stand-in until that store is Desk's one place for
// restorable state, and then is replaced by it (with `grid.` added to its
// prefixes).

import { HubError, type HubConnection } from "../hub/client";
import { hubFetch } from "../hub/net";

export interface GridStorage {
  get(key: string): unknown;
  /** A change made here: kept at once, on the hub shortly. */
  set(key: string, value: unknown): void;
  remove(key: string): void;
  /** Called with the value whenever someone else (the hub, another window)
   *  replaces it; null when they removed it. */
  watch(key: string, f: (value: unknown) => void): () => void;
}

/** The hub's Desk state store. A hub without it throws a 404 `HubError`. */
export interface HubState {
  list(prefix: string): Promise<{ key: string; value: unknown; updatedAt: string | null }[]>;
  put(key: string, value: unknown): Promise<{ updatedAt: string | null }>;
  remove(key: string): Promise<void>;
}

/** One key as kept on this Mac. */
export interface LocalEntry {
  value: unknown;
  /** Changed here and not yet stored by the hub. */
  dirty: boolean;
}

/** This Mac's copy. */
export interface LocalState {
  load(): Record<string, LocalEntry>;
  put(key: string, entry: LocalEntry): void;
  remove(key: string): void;
}

/** JSON with keys sorted, so equal values compare equal. */
export const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

const same = (a: unknown, b: unknown) => stable(a) === stable(b);

const NO_ROUTE = "This hub doesn’t have that yet.";

const routeMissing = (e: unknown) => e instanceof HubError && e.status === 404;

/** How long changes wait before going to the hub together. */
export const HUB_DEBOUNCE_MS = 300;

export class KeptState implements GridStorage {
  private entries = new Map<string, LocalEntry>();
  private watchers = new Map<string, Set<(value: unknown) => void>>();
  private hub: HubState | null = null;
  /** Whether the hub has a state store: unknown until it's asked. */
  hubHas: "unknown" | "no" | "yes" = "unknown";
  private pending = new Set<string>();
  private removed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private readonly local: LocalState,
    private readonly prefix: string,
    /** Tells Desk's other windows about a change made here. */
    private readonly announce: (key: string, value: unknown) => void = () => {},
    private readonly delay = HUB_DEBOUNCE_MS,
  ) {
    for (const [key, e] of Object.entries(local.load())) {
      if (!key.startsWith(prefix)) continue;
      this.entries.set(key, e);
      if (e.dirty) this.pending.add(key);
    }
  }

  get(key: string): unknown {
    return this.entries.get(key)?.value;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  set(key: string, value: unknown): void {
    const was = this.entries.get(key);
    if (was && same(was.value, value)) return;
    const e = { value, dirty: true };
    this.entries.set(key, e);
    this.removed.delete(key);
    this.local.put(key, e);
    this.pending.add(key);
    this.announce(key, value);
    this.schedule();
  }

  remove(key: string): void {
    if (!this.entries.delete(key)) return;
    this.pending.delete(key);
    this.removed.add(key);
    this.local.remove(key);
    this.announce(key, null);
    this.schedule();
  }

  watch(key: string, f: (value: unknown) => void): () => void {
    const set = this.watchers.get(key) ?? new Set();
    set.add(f);
    this.watchers.set(key, set);
    return () => set.delete(f);
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.send(), this.delay);
  }

  /** Sends what's waiting to the hub now. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    await this.send();
  }

  /** The hub is (again) there: once it has a state store, it's sent what it
   *  hasn't been told, and what it has that this Mac didn't change is taken. */
  async connect(hub: HubState | null): Promise<void> {
    this.hub = hub;
    if (!hub) return;
    let remote: Awaited<ReturnType<HubState["list"]>>;
    try {
      remote = await hub.list(this.prefix);
    } catch (e) {
      if (routeMissing(e)) this.hubHas = "no";
      else console.warn("couldn't read the hub's desk state:", e);
      return;
    }
    if (this.hub !== hub) return;
    this.hubHas = "yes";
    const theirs = new Map(remote.map((r) => [r.key, r]));
    for (const [key, e] of this.entries) if (e.dirty || !theirs.has(key)) this.pending.add(key);
    for (const r of remote) {
      if (this.removed.has(r.key) || this.pending.has(r.key)) continue;
      this.take(r.key, r.value);
    }
    await this.send();
  }

  /** A change the hub or another window announced (null: removed); one made
   *  here and not yet on the hub wins. */
  heard(key: string, value: unknown): void {
    if (!key.startsWith(this.prefix) || this.pending.has(key) || this.removed.has(key)) return;
    this.take(key, value);
  }

  private take(key: string, value: unknown) {
    const mine = this.entries.get(key);
    if (value === null || value === undefined) {
      if (!mine) return;
      this.entries.delete(key);
      this.local.remove(key);
    } else {
      if (mine && same(mine.value, value)) return;
      const e = { value, dirty: false };
      this.entries.set(key, e);
      this.local.put(key, e);
    }
    for (const f of this.watchers.get(key) ?? []) f(value ?? null);
  }

  private send(): Promise<void> {
    this.sending = this.sending.then(() => this.sendNow());
    return this.sending;
  }

  private async sendNow(): Promise<void> {
    const hub = this.hub;
    if (!hub || this.hubHas !== "yes") return;
    for (const key of [...this.removed]) {
      try {
        await hub.remove(key);
        this.removed.delete(key);
      } catch (e) {
        if (routeMissing(e)) this.removed.delete(key);
        else return; // The hub is away: tried again when it's back.
      }
    }
    for (const key of [...this.pending]) {
      const e = this.entries.get(key);
      this.pending.delete(key);
      if (!e) continue;
      try {
        await hub.put(key, e.value);
        const now = this.entries.get(key);
        if (now && same(now.value, e.value) && !this.pending.has(key)) {
          const kept = { value: now.value, dirty: false };
          this.entries.set(key, kept);
          this.local.put(key, kept);
        }
      } catch (err) {
        this.pending.add(key);
        if (routeMissing(err)) this.hubHas = "no";
        else console.warn(`couldn't save ${key} on the hub:`, err);
        return;
      }
    }
  }
}

// ── This Mac's copy, in the webview's own storage ─────────────────────────

const LOCAL_PREFIX = "desk.state.";

/** Kept in `localStorage`, which the webview writes to disk; empty (and
 *  nothing kept) where it can't be used. */
export const browserLocalState = (): LocalState => {
  const store = (): Storage | null => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };
  return {
    load: () => {
      const s = store();
      const out: Record<string, LocalEntry> = {};
      if (!s) return out;
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (!k?.startsWith(LOCAL_PREFIX)) continue;
        try {
          const e = JSON.parse(s.getItem(k) ?? "null") as LocalEntry | null;
          if (e && typeof e === "object" && "value" in e) out[k.slice(LOCAL_PREFIX.length)] = { value: e.value, dirty: !!e.dirty };
        } catch {
          /* unreadable: left out */
        }
      }
      return out;
    },
    put: (key, entry) => {
      try {
        store()?.setItem(LOCAL_PREFIX + key, JSON.stringify(entry));
      } catch (e) {
        console.warn(`couldn't keep ${key}:`, e);
      }
    },
    remove: (key) => {
      try {
        store()?.removeItem(LOCAL_PREFIX + key);
      } catch {
        /* nothing kept */
      }
    },
  };
};

export const memoryLocalState = (initial: Record<string, LocalEntry> = {}): LocalState & { all: Record<string, LocalEntry> } => {
  const all = { ...initial };
  return {
    all,
    load: () => ({ ...all }),
    put: (key, entry) => void (all[key] = entry),
    remove: (key) => void delete all[key],
  };
};

// ── The hub's state store, as documented ──────────────────────────────────
// GET /api/desk/state?prefix=…  → rows {key, value, updatedAt}
// PUT /api/desk/state/{key}      ← {value}
// DELETE /api/desk/state/{key}
// and a `{"type":"state","key":…,"value":…}` frame on the events socket.

const row = (x: unknown): { key: string; value: unknown; updatedAt: string | null } | null => {
  if (!x || typeof x !== "object") return null;
  const r = x as { key?: unknown; value?: unknown; updatedAt?: unknown; updated_at?: unknown };
  if (typeof r.key !== "string" || !("value" in r)) return null;
  const at = r.updatedAt ?? r.updated_at;
  return { key: r.key, value: r.value, updatedAt: typeof at === "string" ? at : null };
};

/** A listing as a list of rows, or under `entries`, `items` or `state`. */
export const stateRows = (body: unknown): { key: string; value: unknown; updatedAt: string | null }[] => {
  const o = body as Record<string, unknown> | null;
  const list = Array.isArray(body) ? body : (o?.entries ?? o?.items ?? o?.state ?? o?.states);
  if (!Array.isArray(list)) throw new HubError(404, NO_ROUTE);
  return list.flatMap((x) => row(x) ?? []);
};

export const hubState = (conn: HubConnection): HubState => {
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await hubFetch(new URL(path, conn.url), {
      method,
      headers: { authorization: `Bearer ${conn.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new HubError(res.status, (await res.text().catch(() => "")) || res.statusText);
    if (res.status === 204) return null;
    // A hub without this route answers with its web page.
    if (!(res.headers.get("content-type") ?? "").includes("json")) throw new HubError(404, NO_ROUTE);
    return res.json();
  };
  return {
    list: async (prefix) => stateRows(await call("GET", `/api/desk/state?prefix=${encodeURIComponent(prefix)}`)),
    put: async (key, value) => ({ updatedAt: row(await call("PUT", `/api/desk/state/${encodeURIComponent(key)}`, { value }))?.updatedAt ?? null }),
    remove: async (key) => {
      try {
        await call("DELETE", `/api/desk/state/${encodeURIComponent(key)}`);
      } catch (e) {
        // Already gone is gone; a hub without the store says so another way.
        if (!(e instanceof HubError && e.status === 404 && e.message !== NO_ROUTE)) throw e;
      }
    },
  };
};
