// What Desk restores, by key (`ui.main`, `window.main.<arrangement>`, and
// later grids and terminals): kept in Desk's own file at once and on the
// hub's Desk state store shortly after, so it comes back after a hub
// restart, a quit, a crash or a restart of the Mac.
//
// The file (written by the native side, atomically) is what Desk reads
// before it has a hub, and all it has while the hub has no state store; once
// the hub has one, whatever the hub hasn't been told is sent to it.

import { HubError } from "../hub/client";

export interface StateEntry {
  value: unknown;
  /** When the hub stored it, as it says; none until it has. */
  updatedAt?: string | null;
  /** Changed here and not yet stored by the hub. */
  dirty?: boolean;
}

/** Desk's own file, through its native side. */
export interface LocalState {
  load(): Promise<Record<string, StateEntry>>;
  put(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  synced(key: string, value: unknown, updatedAt: string | null): Promise<void>;
  /** The hub's value (null: it has none), unless this one is dirty; true when taken. */
  adopt(key: string, value: unknown, updatedAt: string | null): Promise<boolean>;
  flush(): Promise<void>;
}

/** The hub's Desk state store. A missing route throws a 404 `HubError`. */
export interface HubState {
  list(prefix: string): Promise<{ key: string; value: unknown; updatedAt: string | null }[]>;
  put(key: string, value: unknown): Promise<{ updatedAt: string | null }>;
  remove(key: string): Promise<void>;
}

/** The key families Desk keeps; another kind of state registers its own. */
export const STATE_PREFIXES = new Set(["ui.", "window."]);

/** JSON with keys sorted, so equal values compare equal. */
export const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

const same = (a: unknown, b: unknown) => stable(a) === stable(b);

const routeMissing = (e: unknown) => e instanceof HubError && e.status === 404;

/** How long changes wait before going to the hub together. */
export const HUB_DEBOUNCE_MS = 300;

/** Where a change came from: made here (this page, or Desk's native side
 *  for window frames), or taken from the hub. */
export type ChangeOrigin = "local" | "native" | "hub";

/** Is notified of every change to keys under `prefix` (value null: removed). */
type Subscriber = { prefix: string; f: (key: string, value: unknown, origin: ChangeOrigin) => void };

/**
 * The keyed store everything restorable goes through:
 * `get` / `set` / `remove` / `list(prefix)`, `subscribe(prefix, …)` for every
 * change and `watch(key, …)` for the hub replacing a value. A new key family
 * is registered with `register("grid.")` (at any time): it is listed from,
 * and sent to, the hub with the rest.
 */
export class DeskStateStore {
  private entries = new Map<string, StateEntry>();
  private watchers = new Map<string, Set<(value: unknown) => void>>();
  private subscribers = new Set<Subscriber>();
  private hub: HubState | null = null;
  /** Whether the hub has a state store: unknown until it's asked. */
  hubHas: "unknown" | "no" | "yes" = "unknown";
  /** Keys whose value the hub hasn't been sent. */
  private pending = new Set<string>();
  /** Keys removed here that the hub still has. */
  private removed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private readonly local: LocalState,
    private readonly delay = HUB_DEBOUNCE_MS,
  ) {}

  /** Reads Desk's file. */
  async load(): Promise<void> {
    const all = await this.local.load();
    for (const [key, e] of Object.entries(all)) {
      this.entries.set(key, e);
      if (e.dirty) this.pending.add(key);
    }
  }

  get(key: string): unknown {
    return this.entries.get(key)?.value;
  }

  entry(key: string): StateEntry | undefined {
    return this.entries.get(key);
  }

  /** Every key under `prefix`, with its value, sorted by key. */
  list(prefix: string): { key: string; value: unknown }[] {
    return [...this.entries]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, e]) => ({ key, value: e.value }));
  }

  /** Every change under `prefix`, wherever it came from. */
  subscribe(prefix: string, f: Subscriber["f"]): () => void {
    const s = { prefix, f };
    this.subscribers.add(s);
    return () => this.subscribers.delete(s);
  }

  private changed(key: string, value: unknown, origin: ChangeOrigin) {
    for (const s of this.subscribers) if (key.startsWith(s.prefix)) s.f(key, value, origin);
  }

  /** A change made here: in the file at once, on the hub shortly. */
  set(key: string, value: unknown): void {
    const was = this.entries.get(key);
    if (was && same(was.value, value)) return;
    this.entries.set(key, { value, updatedAt: was?.updatedAt ?? null, dirty: true });
    this.removed.delete(key);
    this.local.put(key, value).catch((e: unknown) => console.warn(`couldn't keep ${key}:`, e));
    this.pending.add(key);
    this.schedule();
    this.changed(key, value, "local");
  }

  remove(key: string): void {
    if (!this.entries.delete(key)) return;
    this.pending.delete(key);
    this.removed.add(key);
    this.local.remove(key).catch((e: unknown) => console.warn(`couldn't forget ${key}:`, e));
    this.schedule();
    this.changed(key, null, "local");
  }

  /** Changes Desk's native side made and wrote (a window's frame), for the hub. */
  native(changes: [string, StateEntry][]): void {
    for (const [key, e] of changes) {
      this.entries.set(key, { ...e, dirty: true });
      this.pending.add(key);
      this.changed(key, e.value, "native");
    }
    if (changes.length) this.schedule();
  }

  /** Called with the hub's value whenever it replaces this one. */
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

  /** Sends what's waiting to the hub, and has the file written, now. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    await Promise.all([this.send(), this.local.flush().catch(() => undefined)]);
  }

  /** Keeps keys under `prefix` on the hub too; if the hub is connected, its
   *  keys under it are read now (else on connecting). */
  async register(prefix: string): Promise<void> {
    if (STATE_PREFIXES.has(prefix)) return;
    STATE_PREFIXES.add(prefix);
    if (this.hub) await this.connect(this.hub);
  }

  /** The hub is (again) there: asks it for its state store, and once it has
   *  one, sends it what it hasn't been told and takes what it has newer. */
  async connect(hub: HubState | null): Promise<void> {
    this.hub = hub;
    if (!hub) return;
    let remote: Awaited<ReturnType<HubState["list"]>>;
    try {
      remote = (await Promise.all([...STATE_PREFIXES].map((p) => hub.list(p)))).flat();
    } catch (e) {
      // No state store yet: the file keeps everything until there is one.
      if (routeMissing(e)) this.hubHas = "no";
      else console.warn("couldn't read the hub's Desk state; keeping it in Desk's file:", e);
      return;
    }
    if (this.hub !== hub) return;
    this.hubHas = "yes";
    const theirs = new Map(remote.map((r) => [r.key, r]));
    // What only this Mac has (everything, the first time) goes to the hub.
    for (const [key, e] of this.entries) {
      const r = theirs.get(key);
      if (e.dirty || !r) this.pending.add(key);
    }
    for (const r of remote) {
      if (this.removed.has(r.key) || this.pending.has(r.key)) continue;
      await this.take(r.key, r.value, r.updatedAt);
    }
    await this.send();
  }

  /** A change the hub announced (null: removed). */
  async heard(key: string, value: unknown): Promise<void> {
    if (this.pending.has(key) || this.removed.has(key) || this.entries.get(key)?.dirty) return;
    await this.take(key, value, null);
  }

  private async take(key: string, value: unknown, updatedAt: string | null) {
    const mine = this.entries.get(key);
    if (value === null || value === undefined) {
      if (!mine) return;
      if (!(await this.local.adopt(key, null, null))) return;
      this.entries.delete(key);
    } else {
      if (mine && same(mine.value, value)) {
        if (updatedAt && mine.updatedAt !== updatedAt) this.entries.set(key, { ...mine, updatedAt });
        return;
      }
      if (!(await this.local.adopt(key, value, updatedAt))) return;
      // Changed here while the native side was asked.
      if (this.pending.has(key)) return;
      this.entries.set(key, { value, updatedAt, dirty: false });
    }
    for (const f of this.watchers.get(key) ?? []) f(value ?? null);
    this.changed(key, value ?? null, "hub");
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
        const { updatedAt } = await hub.put(key, e.value);
        const now = this.entries.get(key);
        if (now && same(now.value, e.value) && !this.pending.has(key)) {
          this.entries.set(key, { value: now.value, updatedAt, dirty: false });
          await this.local.synced(key, e.value, updatedAt).catch(() => undefined);
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
