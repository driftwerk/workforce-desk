// The connection to Desk: native messaging to Desk Helper, which relays to
// the local hub. The extension says who it is, proves it, waits until the
// person has confirmed this profile in Desk, then does the calls the hub
// makes. Nothing else can reach it: no page, no other extension.

import { perform, Fail, type Exec } from "./commands";
import type { DeskTabs } from "./desk";
import type { Identity } from "./identity";
import { PROTOCOL, fromHub, type Status, type ToHub } from "./protocol";

/** Desk Helper's native messaging host. */
export const HOST = "xyz.driftwerk.desk";

/** What the popup shows. */
export interface LinkState {
  state: "connecting" | "no-desk" | "waiting" | "ready" | "refused";
  why: string | null;
  label: string | null;
  activity: Status["activity"];
}

export interface Port {
  post(m: ToHub): void;
  onMessage(f: (m: unknown) => void): void;
  onDisconnect(f: (why: string | null) => void): void;
  disconnect(): void;
}

export class Link {
  private port: Port | null = null;
  private retry = 1000;
  private changed: (s: LinkState) => void = () => undefined;
  state: LinkState = { state: "connecting", why: null, label: null, activity: null };

  constructor(
    private readonly connect: () => Port,
    private readonly id: () => Promise<Identity>,
    private readonly tabs: DeskTabs,
    private readonly exec: Exec,
    private readonly version: string,
    private readonly later: (f: () => void, ms: number) => void,
  ) {}

  onChange(f: (s: LinkState) => void): void {
    this.changed = f;
  }

  private set(s: Partial<LinkState>): void {
    this.state = { ...this.state, ...s };
    this.changed(this.state);
  }

  /** Connects, and again whenever the connection ends, waiting longer each
   *  time up to a minute. */
  async start(): Promise<void> {
    const me = await this.id();
    this.set({ state: "connecting", label: me.label });
    const port = this.connect();
    this.port = port;
    port.onDisconnect((why) => {
      if (this.port !== port) return;
      this.port = null;
      this.set({ state: "no-desk", why: why ?? "Desk isn't running on this computer.", activity: null });
      this.later(() => void this.start(), this.retry);
      this.retry = Math.min(this.retry * 2, 60_000);
    });
    port.onMessage((raw) => void this.take(raw, me, port));
    port.post({ type: "hello", protocol: PROTOCOL, version: this.version, key: me.publicKey, label: me.label });
  }

  private async take(raw: unknown, me: Identity, port: Port): Promise<void> {
    const m = fromHub(raw);
    if (!m) return;
    switch (m.type) {
      case "challenge":
        port.post({ type: "proof", signature: await me.sign(m.nonce) });
        if (m.state === "pending") this.set({ state: "waiting", why: "Confirm this Chrome in Desk." });
        return;
      case "waiting":
        this.set({ state: "waiting", why: m.why });
        return;
      case "ready":
        this.retry = 1000;
        this.set({ state: "ready", why: null });
        return;
      case "refused":
        this.set({ state: "refused", why: m.why });
        return;
      case "status":
        this.set({ activity: m.activity });
        return;
      case "call": {
        if (this.state.state !== "ready") {
          port.post({ type: "result", id: m.id, ok: false, error: "This Chrome isn't confirmed in Desk yet." });
          return;
        }
        try {
          const value = await perform(m, this.tabs, this.exec);
          port.post({ type: "result", id: m.id, ok: true, value: value ?? null });
        } catch (e) {
          const error = e instanceof Fail ? e.message : `Chrome said: ${e instanceof Error ? e.message : String(e)}`;
          port.post({ type: "result", id: m.id, ok: false, error });
        }
        return;
      }
    }
  }

  /** The person closed one of Desk's tabs. */
  tabClosed(session: string): void {
    this.port?.post({ type: "event", event: "tab-closed", session });
  }

  /** The popup's Stop: Desk's tabs close, and the hub is told. */
  async stop(): Promise<void> {
    await this.tabs.stop();
    this.port?.post({ type: "event", event: "stopped" });
    this.set({ activity: null });
  }
}
